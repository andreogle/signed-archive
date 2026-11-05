import type { Database } from 'bun:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { concatHex, encodeAbiParameters, type Hex, keccak256, stringToHex } from 'viem';
import { type Catalog, type CatalogInput, createCatalog } from './catalog.ts';
import { MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS, USER_AGENT } from './config.ts';
import { readCapped, retryAfterMs } from './http.ts';
import { log } from './logger.ts';
import { go } from './result.ts';
import { parseAirnodes, parseFeeds } from './settings.ts';

const REPOSITORY = 'api3dao/api-integrations-data';
const CHECK_EVERY_MS = 60 * 60_000;
export const CATALOG_SNAPSHOTS = `CREATE TABLE IF NOT EXISTS catalog_snapshots (
  id INTEGER PRIMARY KEY,
  revision TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  contents TEXT NOT NULL
)`;

interface Snapshot {
  id: number;
  revision: string;
  contents: string;
  observed_at: number;
}

// Read-only processes follow the writer's catalogue through SQLite, including after a container restart. Older
// snapshots supply names for evidence; only the newest snapshot supplies polling targets.
export function catalogReader(db: Database) {
  let cached: { id: number; catalog: Catalog } | undefined;
  return (fallback: Catalog): Catalog => {
    const exists = db.query("SELECT 1 FROM sqlite_master WHERE name = 'catalog_snapshots' AND type = 'table'").get();
    if (!exists) return fallback;
    // Only the id per call: contents are parsed again only when a new snapshot lands.
    const latest = db.query<{ id: number }, []>('SELECT id FROM catalog_snapshots ORDER BY id DESC LIMIT 1').get();
    if (!latest) return fallback;
    if (cached?.id === latest.id) return cached.catalog;
    // The last row read below is the latest snapshot.
    let current: CatalogInput = { airnodes: [], feeds: {} };
    const historical = new Map<string, NonNullable<CatalogInput['historical']>[number]>();
    for (const row of db
      .query<Snapshot, { id: number }>(
        'SELECT id, revision, contents, observed_at FROM catalog_snapshots WHERE id <= $id ORDER BY id'
      )
      .all({ id: latest.id })) {
      current = JSON.parse(row.contents) as CatalogInput;
      const snapshot = createCatalog(current);
      const active = new Set<string>();
      for (const [feed, sources] of snapshot.feeds) {
        for (const source of sources.public) {
          const key = `${feed}:${source.airnode.toLowerCase()}:${source.templateId.toLowerCase()}`;
          active.add(key);
          historical.set(key, {
            feed,
            ...source,
          });
        }
      }
      for (const [key, source] of historical) {
        if (!active.has(key) && source.retiredAt === undefined) source.retiredAt = Math.floor(row.observed_at / 1000);
      }
    }
    const catalog = createCatalog({ ...current, historical: [...historical.values()], revision: latest.id });
    cached = { id: latest.id, catalog };
    return catalog;
  };
}

export function saveCatalog(db: Database, input: CatalogInput, revision: string) {
  const contents = JSON.stringify({ airnodes: input.airnodes, feeds: input.feeds });
  const last = db
    .query<Snapshot, []>('SELECT id, revision, contents FROM catalog_snapshots ORDER BY id DESC LIMIT 1')
    .get();
  // An upstream commit that leaves the catalogue unchanged adds no row: every row is reparsed when a new one lands.
  if (last?.contents === contents) return false;
  db.query('INSERT INTO catalog_snapshots (revision, observed_at, contents) VALUES ($revision, $at, $contents)').run({
    revision,
    at: Date.now(),
    contents,
  });
  return true;
}

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('expected a catalogue object');
  return value as Record<string, unknown>;
};

// API3's template is keccak256(endpointId || Airnode ABI parameters). The sole parameter is string32 "name";
// encode it with viem so runtime discovery never imports the API integrations package or executes downloaded code.
export function templateFor(ois: string, feed: string): Hex {
  if (new TextEncoder().encode(feed).length > 31 || feed.includes('\0')) throw new Error('invalid feed name');
  const endpoint = keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'string' }], [ois, 'feed']));
  return keccak256(
    concatHex([
      endpoint,
      stringToHex('1s', { size: 32 }),
      stringToHex('name', { size: 32 }),
      stringToHex(feed, { size: 32 }),
    ])
  );
}

export function parseApi3Catalog(documents: readonly unknown[]): CatalogInput {
  const providers = documents
    .map((value) => {
      const api = object(value);
      if (typeof api.alias !== 'string' || !/^[a-z0-9-]+$/.test(api.alias)) throw new Error('invalid provider alias');
      const list = parseAirnodes(
        JSON.stringify({ airnodes: [{ alias: api.alias, airnode: api.airnode, signedApiUrl: api.signedApiUrl }] })
      );
      const entry = list[0];
      if (!entry) throw new Error('missing provider');
      const url = new URL(entry.signedApiUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash)
        throw new Error('invalid provider URL');
      const feeds = new Map<string, Hex>();
      for (const [ois, batches] of Object.entries(object(api.supportedFeedsInBatches))) {
        if (!ois || !Array.isArray(batches)) throw new Error('invalid feed batches');
        for (const batch of batches) {
          if (!Array.isArray(batch)) throw new Error('invalid feed batch');
          for (const feed of batch) {
            if (typeof feed !== 'string' || !feed) throw new Error('invalid feed name');
            const template = templateFor(ois, feed);
            if (feeds.has(feed) && feeds.get(feed) !== template) throw new Error('ambiguous feed template');
            feeds.set(feed, template);
          }
        }
      }
      return { entry, feeds };
    })
    .sort((a, b) => a.entry.alias.localeCompare(b.entry.alias));
  const airnodes = parseAirnodes(JSON.stringify({ airnodes: providers.map(({ entry }) => entry) }));
  if (new Set(airnodes.map(({ airnode }) => airnode.toLowerCase())).size !== airnodes.length)
    throw new Error('duplicate airnode');
  const names = [...new Set(providers.flatMap(({ feeds }) => [...feeds.keys()]))].sort();
  const feeds = Object.fromEntries(
    names.map((name) => {
      return [
        name,
        Object.fromEntries(
          providers.flatMap(({ entry, feeds }) => {
            const template = feeds.get(name);
            return template ? [[entry.alias, template]] : [];
          })
        ),
      ];
    })
  );
  return { airnodes, feeds: parseFeeds(JSON.stringify({ feeds }), airnodes) };
}

class CatalogFetchError extends Error {
  readonly retryMs: number | null;
  constructor(message: string, retryMs: number | null) {
    super(message);
    this.retryMs = retryMs;
  }
}

export interface DiscoveryOptions {
  signal: AbortSignal;
  revision?: string;
  // Tests use a local HTTP fixture; production always uses API3's repository on GitHub.
  apiUrl?: string;
  rawUrl?: string;
}

export async function discoverCatalog({
  signal,
  revision,
  apiUrl = 'https://api.github.com',
  rawUrl = 'https://raw.githubusercontent.com',
}: DiscoveryOptions) {
  let remainingBytes = MAX_RESPONSE_BYTES;
  const read = async (url: string): Promise<unknown> => {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000 - Date.now();
      const retry = retryAfterMs(response.headers.get('retry-after'), Date.now());
      throw new CatalogFetchError(`catalogue HTTP ${response.status}`, retry ?? (reset > 0 ? reset : null));
    }
    const text = await readCapped(response, remainingBytes);
    if (text === null) throw new Error('catalogue response too large');
    remainingBytes -= new TextEncoder().encode(text).length;
    return JSON.parse(text);
  };
  // Pin the directory listing and every provider file to one revision, so a mid-fetch upstream commit cannot mix versions.
  const tree = object(await read(`${apiUrl}/repos/${REPOSITORY}/git/trees/main`));
  const sha = tree.sha;
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('invalid catalogue revision');
  if (sha === revision) return null;
  const listing = await read(`${apiUrl}/repos/${REPOSITORY}/contents/data/apis?ref=${sha}`);
  if (!Array.isArray(listing) || listing.length > 256) throw new Error('invalid provider listing');
  const names: string[] = [];
  for (const value of listing) {
    const item = object(value);
    if (item.type !== 'dir') continue;
    if (typeof item.name !== 'string' || !/^[a-z0-9-]+$/.test(item.name)) throw new Error('invalid provider path');
    if (!item.name.endsWith('-mock')) names.push(item.name);
  }
  if (new Set(names).size !== names.length) throw new Error('duplicate provider path');
  const documents: unknown[] = [];
  for (const name of names.sort()) {
    const api = object(await read(`${rawUrl}/${REPOSITORY}/${sha}/data/apis/${name}/api-data.json`));
    if (api.alias !== name) throw new Error('provider alias does not match path');
    // Providers without a public Signed API are not polling targets.
    if (api.signedApiUrl !== '') documents.push(api);
  }
  return { revision: sha, input: parseApi3Catalog(documents) };
}

export interface CatalogUpdateOptions extends Omit<DiscoveryOptions, 'revision'> {
  revision: () => string | undefined;
  // Whether the snapshot was new; an unchanged catalogue under a new revision adds nothing.
  apply: (input: CatalogInput, revision: string) => boolean;
  checkEveryMs?: number;
}

// Background discovery never holds up polling. Apply is called only after the entire new snapshot validates.
export async function runCatalogUpdates({
  revision,
  apply,
  checkEveryMs = CHECK_EVERY_MS,
  ...options
}: CatalogUpdateOptions) {
  let failures = 0;
  // The newest revision checked, newer than the stored one when upstream changed nothing this archive keeps.
  let checked: string | undefined;
  while (!options.signal.aborted) {
    let wait = checkEveryMs;
    const [error] = await go(async () => {
      const result = await discoverCatalog({ ...options, revision: checked ?? revision() });
      if (!result || options.signal.aborted) return;
      const changed = apply(result.input, result.revision);
      checked = result.revision;
      if (!changed) return;
      log.info('catalog updated', {
        revision: result.revision,
        providers: result.input.airnodes.length,
        feeds: Object.keys(result.input.feeds).length,
      });
    });
    if (options.signal.aborted) break;
    if (error === undefined) {
      failures = 0;
    } else {
      failures += 1;
      wait = Math.min(
        24 * CHECK_EVERY_MS,
        Math.max(
          Math.min(checkEveryMs, 60_000 * 2 ** Math.min(failures - 1, 6)),
          error instanceof CatalogFetchError ? (error.retryMs ?? 0) : 0
        )
      );
      log.warn('catalog update failed', { error: error.message, retryInSeconds: Math.ceil(wait / 1000) });
    }
    const [stopped] = await go(() => sleep(wait, undefined, { signal: options.signal }));
    if (stopped) break;
  }
}
