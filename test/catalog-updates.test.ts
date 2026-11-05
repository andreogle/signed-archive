import { Database } from 'bun:sqlite';
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleApi } from '../src/api.ts';
import { reconcileTargets, runArchiver } from '../src/archiver.ts';
import { type CatalogInput, createCatalog } from '../src/catalog.ts';
import {
  CATALOG_SNAPSHOTS,
  catalogReader,
  discoverCatalog,
  parseApi3Catalog,
  runCatalogUpdates,
  saveCatalog,
  templateFor,
} from '../src/catalog-updates.ts';
import { MAX_RESPONSE_BYTES } from '../src/config.ts';
import { summarizeConflicts } from '../src/conflicts.ts';
import { handleMcp } from '../src/mcp.ts';
import { openReader } from '../src/reader.ts';
import { backupArchive, openStore } from '../src/store.ts';
import { blocksize, coingecko, catalog as fixtures } from './fixtures.ts';

const dir = mkdtempSync(join(tmpdir(), 'signed-archive-catalog-'));
const sha = 'a'.repeat(40);
// Captured fields from API3's data/apis/coingecko/api-data.json; retain just one real feed.
const provider = {
  alias: 'coingecko',
  airnode: coingecko.airnode,
  signedApiUrl: 'https://signed-api.coingecko.com',
  supportedFeedsInBatches: { CoinGecko: [['ETH/USD']] },
};
const input = parseApi3Catalog([provider]);
const empty = createCatalog({ airnodes: [], feeds: {} });
const requests: URL[] = [];
const respond = (url: URL): Response => {
  if (url.pathname.endsWith('/git/trees/main')) return Response.json({ sha });
  if (url.pathname.endsWith('/contents/data/apis'))
    return Response.json([
      { name: 'coingecko', type: 'dir' },
      { name: 'coingecko-mock', type: 'dir' },
      { name: 'README.md', type: 'file' },
    ]);
  return Response.json(provider);
};
let answer = respond;
const server = Bun.serve({
  port: 0,
  fetch: (request) => {
    const url = new URL(request.url);
    requests.push(url);
    return answer(url);
  },
});
const origin = server.url.origin;
const options = { apiUrl: origin, rawUrl: origin, signal: new AbortController().signal };

afterAll(() => {
  void server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test('derives the real API3 template without the integrations package, and validates complete provider data', () => {
  expect(templateFor('CoinGecko', 'ETH/USD')).toBe(coingecko.templateId);
  expect(input.feeds['ETH/USD']?.coingecko).toBe(fixtures.input.feeds['ETH/USD']?.coingecko);
  expect(parseApi3Catalog([])).toEqual({ airnodes: [], feeds: {} });
  const another = {
    ...provider,
    alias: 'another',
    airnode: blocksize[0]?.airnode,
    supportedFeedsInBatches: { Other: [['BTC/USD'], ['BTC/USD']] },
  };
  expect(parseApi3Catalog([provider, another]).airnodes.map((entry) => entry.alias)).toEqual(['another', 'coingecko']);
  for (const value of [
    null,
    [],
    {},
    { ...provider, alias: '../x' },
    { ...provider, airnode: '0x12' },
    { ...provider, signedApiUrl: 'http://example.com' },
    { ...provider, signedApiUrl: 'https://user:secret@example.com' },
    { ...provider, supportedFeedsInBatches: null },
    { ...provider, supportedFeedsInBatches: { '': [] } },
    { ...provider, supportedFeedsInBatches: { OIS: 'bad' } },
    { ...provider, supportedFeedsInBatches: { OIS: ['bad'] } },
    { ...provider, supportedFeedsInBatches: { OIS: [[12]] } },
    { ...provider, supportedFeedsInBatches: { First: [['ETH/USD']], Second: [['ETH/USD']] } },
  ]) {
    expect(() => parseApi3Catalog([value])).toThrow();
  }
  expect(() => parseApi3Catalog([provider, provider])).toThrow('twice');
  expect(() => parseApi3Catalog([provider, { ...provider, alias: 'other' }])).toThrow('duplicate airnode');
  expect(() => templateFor('CoinGecko', 'x'.repeat(32))).toThrow('invalid feed');
  expect(() => templateFor('CoinGecko', 'a\0b')).toThrow('invalid feed');
});

test('pins every file to one revision, ignores mocks, and skips unchanged revisions', async () => {
  answer = respond;
  requests.length = 0;
  expect(await discoverCatalog(options)).toEqual({ revision: sha, input });
  expect(requests[1]?.searchParams.get('ref')).toBe(sha);
  expect(requests[2]?.pathname).toContain(`/${sha}/data/apis/coingecko/api-data.json`);
  expect(requests).toHaveLength(3);
  requests.length = 0;
  expect(await discoverCatalog({ ...options, revision: sha })).toBeNull();
  expect(requests).toHaveLength(1);
  answer = (url) =>
    url.pathname.endsWith('api-data.json') ? Response.json({ ...provider, signedApiUrl: '' }) : respond(url);
  expect((await discoverCatalog(options))?.input.airnodes).toEqual([]);
});

test('rejects incomplete, oversized, redirected and malformed snapshots without applying any part', async () => {
  const wrongTree = (value: unknown) => (url: URL) =>
    url.pathname.endsWith('/git/trees/main') ? Response.json(value) : respond(url);
  const wrongList = (value: unknown) => (url: URL) =>
    url.pathname.endsWith('/contents/data/apis') ? Response.json(value) : respond(url);
  for (const response of [
    wrongTree({ sha: 'bad' }),
    wrongList({}),
    wrongList(new Array(257).fill({})),
    wrongList([{ type: 'dir', name: '../bad' }]),
    wrongList([
      { type: 'dir', name: 'coingecko' },
      { type: 'dir', name: 'coingecko' },
    ]),
    (url: URL) =>
      url.pathname.endsWith('api-data.json') ? Response.json({ ...provider, alias: 'other' }) : respond(url),
    () => new Response('bad', { status: 503 }),
    () => new Response('bad json'),
    () => new Response('', { headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } }),
    () => new Response(null, { status: 302, headers: { location: `${origin}/redirected` } }),
  ]) {
    answer = response;
    await expect(discoverCatalog(options)).rejects.toThrow();
  }
  answer = respond;
  await expect(discoverCatalog({ ...options, signal: AbortSignal.abort() })).rejects.toThrow();
});

test('background discovery retries failure, preserves a rejected snapshot and stops with the archiver', async () => {
  let attempts = 0;
  answer = (url) => {
    if (url.pathname.endsWith('/git/trees/main') && attempts++ === 0)
      return new Response('busy', { status: 429, headers: { 'retry-after': '0' } });
    return respond(url);
  };
  const stop = new AbortController();
  const applied: CatalogInput[] = [];
  await runCatalogUpdates({
    ...options,
    signal: stop.signal,
    revision: () => undefined,
    checkEveryMs: 1,
    apply: (next) => {
      applied.push(next);
      stop.abort();
    },
  });
  expect(attempts).toBe(2);
  expect(applied).toEqual([input]);
  // A long Retry-After is respected, but shutdown interrupts it immediately.
  const waiting = new AbortController();
  attempts = 0;
  answer = () => {
    attempts += 1;
    setTimeout(() => waiting.abort(), 20);
    return new Response('limited', {
      status: 403,
      headers: { 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 60) },
    });
  };
  await runCatalogUpdates({
    ...options,
    signal: waiting.signal,
    revision: () => undefined,
    checkEveryMs: 1,
    apply: () => {
      throw new Error('must not apply');
    },
  });
  expect(attempts).toBe(1);
  answer = respond;
  await runCatalogUpdates({
    ...options,
    signal: AbortSignal.abort(),
    revision: () => undefined,
    apply: () => {
      throw new Error('must not apply');
    },
  });
});

test('reconciles additions, removals, signer and URL changes while preserving unaffected backoff', () => {
  const first = reconcileTargets(createCatalog(input), [], 'https://api3.example');
  for (const target of first) {
    target.failures = 3;
    target.retryAt = 999;
    target.feeds = new Set([coingecko.templateId]);
  }
  const next = structuredClone(input);
  const entry = next.airnodes[0];
  if (!entry) throw new Error('missing fixture');
  entry.signedApiUrl = 'https://new.example';
  entry.alias = 'renamed';
  const changed = reconcileTargets(createCatalog(next), first, 'https://api3.example');
  expect(
    changed
      .filter((target) => target.source === 'api3')
      .every((target) => target.failures === 3 && target.retryAt === 999)
  ).toBe(true);
  expect(changed.filter((target) => target.source === 'provider').every((target) => target.failures === 0)).toBe(true);
  expect(changed.every((target) => target.alias === 'renamed')).toBe(true);
  entry.airnode = blocksize[0]?.airnode ?? coingecko.airnode;
  expect(
    reconcileTargets(createCatalog(next), first, 'https://api3.example').every((target) => target.failures === 0)
  ).toBe(true);
  next.airnodes.push(...input.airnodes);
  expect(reconcileTargets(createCatalog(next), first, 'https://api3.example')).toHaveLength(8);
  expect(reconcileTargets(empty, first, 'https://api3.example')).toEqual([]);
});

test('readers, API and MCP follow snapshots and retain removed mappings after reopening', async () => {
  const path = join(dir, 'history.sqlite');
  const store = openStore(path);
  const reader = openReader(path);
  expect(reader.catalog(empty)).toBe(empty);
  store.saveCatalog(input, 'first');
  store.saveCatalog(input, 'first');
  const first = reader.catalog(empty);
  expect(first.input.revision).toBe(1);
  expect(reader.catalog(empty)).toBe(first);
  store.add([{ datum: coingecko, endpoint: 'public', fetchedAt: Number(coingecko.timestamp) * 1000 }], []);
  const removed: CatalogInput = { airnodes: [], feeds: {} };
  store.saveCatalog(removed, 'removed');
  const historical = reader.catalog(empty);
  expect(historical.airnodes).toEqual([]);
  expect(historical.knows(coingecko.airnode)).toBe(true);
  expect(historical.aliasOf(coingecko.airnode)).toBe('coingecko');
  expect(historical.isFeedRecord('ETH/USD', 'public', { ...coingecko, provider: 'coingecko' })).toBe(true);
  expect(historical.sourcesOfAirnode(coingecko.airnode, 'public-oev')).toHaveLength(1);
  const at = await handleApi(reader, empty, new URL(`http://local/api/at?feed=ETH/USD&time=${coingecko.timestamp}`));
  expect((await at.json()).records).toHaveLength(1);
  const listed = await handleApi(reader, empty, new URL('http://local/api/catalog'));
  expect((await listed.json()).historical).toHaveLength(1);
  const mcp = await handleMcp(reader, empty, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'get_price_at', arguments: { feed: 'ETH/USD', time: Number(coingecko.timestamp) } },
  });
  expect(mcp).not.toHaveProperty('error');
  expect(JSON.stringify(mcp)).toContain(coingecko.signature);
  reader.close();
  store.close();
  const reopened = openReader(path);
  expect(reopened.catalog(empty).sourcesOfAirnode(coingecko.airnode, 'public')).toHaveLength(1);
  reopened.close();
});

test('a rotated signer or template keeps history but contributes only the newest provider record at a moment', async () => {
  const path = join(dir, 'rotation.sqlite');
  const store = openStore(path);
  const previous = blocksize[0];
  if (!previous) throw new Error('missing fixture');
  const old: CatalogInput = {
    airnodes: [{ alias: 'coingecko', airnode: previous.airnode, signedApiUrl: 'https://old.example' }],
    feeds: { 'ETH/USD': { coingecko: previous.templateId } },
  };
  store.saveCatalog(old, 'old');
  store.saveCatalog(input, 'new');
  store.add(
    [previous, coingecko].map((datum) => ({
      datum,
      endpoint: 'public' as const,
      fetchedAt: Number(datum.timestamp) * 1000,
    })),
    []
  );
  const catalog = store.catalog(empty);
  const sources = catalog.feeds.get('ETH/USD')?.public ?? [];
  expect(sources).toHaveLength(2);
  const reader = openReader(path);
  expect((await reader.at(sources, Number(previous.timestamp))).map((record) => record.signature)).toEqual([
    previous.signature,
  ]);
  expect((await reader.at(sources, Number(coingecko.timestamp))).map((record) => record.signature)).toEqual([
    coingecko.signature,
  ]);
  expect(await reader.records(sources, 0, 2e9)).toHaveLength(2);
  const history = await reader.history(sources, Number(previous.timestamp), Number(coingecko.timestamp), 1);
  expect(history).toHaveLength(1);
  expect(history[0]?.points).toHaveLength(1);
  expect(history[0]?.points[0]?.timestamp).toBe(Number(coingecko.timestamp));
  reader.close();
  store.close();
});

test('legacy readers use the configured catalogue until a writer creates the snapshot table', () => {
  const db = new Database(':memory:');
  const current = catalogReader(db);
  expect(current(empty)).toBe(empty);
  db.run(CATALOG_SNAPSHOTS);
  saveCatalog(db, input, sha);
  expect(current(empty).airnodes).toEqual(input.airnodes);
  db.close();
});

test('automatic discovery resumes the persisted catalogue on restart and polling survives an upstream outage', async () => {
  const dbPath = join(dir, 'automatic.sqlite');
  const store = openStore(dbPath);
  const cached = structuredClone(input);
  for (const entry of cached.airnodes) entry.signedApiUrl = origin;
  store.saveCatalog(cached, 'cached');
  store.close();
  answer = (url) => {
    if (url.pathname.includes('/public')) return Response.json({ data: { coingecko } });
    return new Response('upstream unavailable', { status: 503 });
  };
  const stop = new AbortController();
  const timeout = setTimeout(() => stop.abort(), 150);
  await runArchiver({
    dbPath,
    catalog: empty,
    discoverCatalog: true,
    catalogOrigin: options,
    intervalSeconds: 0.04,
    api3Url: origin,
    signal: stop.signal,
  });
  clearTimeout(timeout);
  const reader = openReader(dbPath);
  expect(reader.catalog(empty).airnodes).toEqual(cached.airnodes);
  expect(reader.lastPoll()).not.toBeNull();
  expect(await reader.records(reader.catalog(empty).feeds.get('ETH/USD')?.public ?? [], 0, 2e9)).toHaveLength(1);
  reader.close();
  answer = respond;
});

test('template changes, feed deletion and re-addition keep history while current price checks use only active sources', async () => {
  const dbPath = join(dir, 'membership.sqlite');
  const store = openStore(dbPath);
  store.saveCatalog(input, 'original');
  const changed = structuredClone(input);
  const template = `0x${'11'.repeat(32)}` as const;
  changed.feeds = { 'ETH/USD': { coingecko: template }, 'NEW/USD': { coingecko: coingecko.templateId } };
  store.saveCatalog(changed, 'changed');
  const current = store.catalog(empty);
  expect(current.activeFeeds.get('ETH/USD')?.public.map((source) => source.templateId)).toEqual([template]);
  expect(current.feeds.get('ETH/USD')?.public).toHaveLength(2);
  expect(current.feeds.has('NEW/USD')).toBe(true);
  store.add([{ datum: coingecko, endpoint: 'public', fetchedAt: 1 }], []);
  store.saveCatalog({ airnodes: input.airnodes, feeds: {} }, 'feed-removed');
  const reader = openReader(dbPath);
  expect(reader.catalog(empty).airnodes).toHaveLength(1);
  const response = await handleMcp(reader, empty, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'check_price', arguments: { feed: 'ETH/USD' } },
  });
  expect(JSON.stringify(response)).toContain('no verified signed records');
  expect(JSON.stringify(response)).not.toContain(coingecko.signature);
  expect(reader.catalog(empty).isFeedRecord('ETH/USD', 'public', { ...coingecko, provider: 'coingecko' })).toBe(true);
  store.saveCatalog(input, 'restored');
  expect(reader.catalog(empty).activeFeeds.get('ETH/USD')?.public).toHaveLength(1);
  expect(reader.catalog(empty).feeds.get('ETH/USD')?.public).toHaveLength(2);
  const { path } = await backupArchive(dbPath, join(dir, 'snapshot-backup'));
  const backup = openReader(path);
  expect(backup.catalog(empty).input).toEqual(reader.catalog(empty).input);
  backup.close();
  reader.close();
  store.close();
});

test('retired providers keep conflict names and do not create endless chart gaps after removal', async () => {
  const dbPath = join(dir, 'retired.sqlite');
  const store = openStore(dbPath);
  store.saveCatalog(input, 'original');
  // Synthetic rows test aggregation only. Real signature recovery is covered by the signed-data fixtures.
  for (const offset of [0, 10]) {
    for (const multiplier of [1n, 2n + BigInt(offset)]) {
      const datum = {
        ...coingecko,
        timestamp: String(Number(coingecko.timestamp) + offset),
        encodedValue: `0x${(BigInt(coingecko.encodedValue) * multiplier).toString(16).padStart(64, '0')}` as const,
      };
      store.add([{ datum, endpoint: 'public', fetchedAt: 1 }], []);
    }
  }
  store.save([], {
    airnode: coingecko.airnode,
    endpoint: 'public',
    source: 'api3',
    status: 200,
    fetchedAt: Date.now(),
    received: 0,
    rejected: 0,
  });
  store.saveCatalog({ airnodes: [], feeds: {} }, 'retired');
  const reader = openReader(dbPath);
  const catalog = reader.catalog(empty);
  const summary = await summarizeConflicts(reader, catalog, 0, 2e9);
  expect(summary[0]).toMatchObject({ provider: 'coingecko', conflicts: 2 });
  expect(summary[0]?.widest.timestamp).toBe(Number(coingecko.timestamp) + 10);
  const sources = catalog.feeds.get('ETH/USD')?.public ?? [];
  const retired = sources[0]?.retiredAt ?? 0;
  expect(retired).toBeGreaterThan(0);
  expect(reader.gaps(sources, 'public', retired, retired + 10_000)).toEqual([]);
  expect(reader.gaps(sources, 'public', retired + 1, retired + 10_000)).toEqual([]);
  reader.close();
  store.close();
});
