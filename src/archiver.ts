import { SQLiteError } from 'bun:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { type Address, isAddressEqual } from 'viem';
import type { Catalog } from './catalog.ts';
import {
  BASE_URL,
  ENDPOINTS,
  type Endpoint,
  MAX_BACKOFF_MS,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
  SOURCES,
  type Source,
  USER_AGENT,
} from './config.ts';
import { sendHeartbeat } from './heartbeat.ts';
import { readCapped, retryAfterMs } from './http.ts';
import { errorMessage, log } from './logger.ts';
import { DEFAULT_AFTER_DAYS, runMoves } from './parquet.ts';
import { runRepairs } from './repair.ts';
import { hasValidSignature, type SignedDatum, toSignedDatum } from './signed-data.ts';
import { openStore } from './store.ts';

export interface Target {
  alias: string;
  airnode: Address;
  endpoint: Endpoint;
  source: Source;
  // Signed API base URL for this source: API3's, or the provider's own.
  baseUrl: string;
  failures: number;
  // When the target may be asked again, on the monotonic clock (`performance.now()`), so a wall-clock step can't
  // stretch or skip a backoff.
  retryAt: number;
  // Template IDs seen so far; null until the first successful fetch.
  feeds: Set<string> | null;
}

type Store = ReturnType<typeof openStore>;

export interface ArchiverOptions {
  intervalSeconds: number;
  dbPath: string;
  catalog: Catalog;
  heartbeatUrl?: URL | undefined;
  peers?: readonly URL[];
  // Where closed days' Parquet files go, and how many days after a day ends it moves there. Without a directory,
  // records stay in SQLite.
  parquetDir?: string | undefined;
  afterDays?: number;
  // API3's Signed API; tests point it at a local server.
  api3Url?: string;
  // Stops the archiver like SIGINT or SIGTERM do.
  signal?: AbortSignal;
}

export function backOff(target: Target, intervalMs: number, retryAfter: string | null) {
  target.failures += 1;
  const asked = retryAfterMs(retryAfter, Date.now());
  const delay = asked !== null && asked > 0 ? asked : intervalMs * 2 ** target.failures;
  const capped = Math.min(delay, MAX_BACKOFF_MS);
  target.retryAt = performance.now() + capped;
  return Math.round(capped / 1000);
}

const fieldsOf = ({ alias, endpoint, source }: Target) => ({ provider: alias, endpoint, source });

function trackFeeds(target: Target, data: readonly SignedDatum[]) {
  const fields = fieldsOf(target);
  if (!target.feeds) {
    target.feeds = new Set(data.map(({ templateId }) => templateId));
    log.info('feeds found', { ...fields, feeds: target.feeds.size });
    return;
  }
  for (const { templateId } of data) {
    if (target.feeds.has(templateId)) continue;
    target.feeds.add(templateId);
    log.info('new feed', { ...fields, templateId, feeds: target.feeds.size });
  }
}

// Records a request that saved nothing, so the coverage log shows the provider (not the archiver) was down.
// `status` is the HTTP status, or null when no usable response came back.
// A database error here is logged rather than thrown, so it can't stop the archiver.
function recordFailure(store: Store, target: Target, status: number | null) {
  try {
    store.save([], {
      airnode: target.airnode,
      endpoint: target.endpoint,
      source: target.source,
      fetchedAt: Date.now(),
      status,
      received: 0,
      rejected: 0,
    });
  } catch (error) {
    if (!(error instanceof SQLiteError)) throw error;
    log.error('save failed', { ...fieldsOf(target), error: errorMessage(error) });
  }
}

export async function poll(target: Target, store: Store, intervalMs: number, stop: AbortSignal) {
  const fields = fieldsOf(target);
  const response = await fetch(`${target.baseUrl}/${target.endpoint}/${target.airnode}`, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), stop]),
  });
  if (!response.ok) {
    recordFailure(store, target, response.status);
    const retryInSeconds = backOff(target, intervalMs, response.headers.get('retry-after'));
    log.warn('fetch failed', { ...fields, status: response.status, retryInSeconds });
    return null;
  }
  const fetchedAt = Date.now();
  const text = await readCapped(response, MAX_RESPONSE_BYTES);
  if (text === null) throw new Error(`response over ${MAX_RESPONSE_BYTES} bytes`);
  const body: unknown = JSON.parse(text);
  const raw = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined;
  if (typeof raw !== 'object' || raw === null) throw new Error('response has no data object');

  // Duplicates are dropped before the signature check, the slow step, so a host repeating one record can't stall
  // the loop. Include the signer and signature so a forged copy cannot hide a genuine one that follows it.
  const seen = new Set<string>();
  const valid = [];
  let rejected = 0;
  for (const value of Object.values(raw)) {
    const datum = toSignedDatum(value);
    const key = datum && Object.values(datum).join(':').toLowerCase();
    if (key !== null && seen.has(key)) continue;
    if (key !== null) seen.add(key);
    if (datum && isAddressEqual(datum.airnode, target.airnode) && (await hasValidSignature(datum))) {
      valid.push(datum);
    } else {
      rejected += 1;
    }
  }
  if (target.failures > 0) log.info('fetch recovered', { ...fields, failures: target.failures });
  target.failures = 0;
  trackFeeds(target, valid);
  const received = valid.length + rejected;
  const { airnode, endpoint, source } = target;
  const saved = store.save(valid, {
    airnode,
    endpoint,
    source,
    fetchedAt,
    status: response.status,
    received,
    rejected,
  });
  if (rejected > 0) log.warn('rejected records', { ...fields, rejected });
  log.debug('fetched', { ...fields, received, saved });
  return { saved, rejected };
}

// A request that threw. A fetch or response error is the host's: the target backs off and the failure is recorded. A
// database error is ours, so the host isn't blamed or backed off; the next request tries the database again.
function noteFailure(store: Store, target: Target, intervalMs: number, error: unknown) {
  const fields = fieldsOf(target);
  if (error instanceof SQLiteError) {
    log.error('save failed', { ...fields, error: errorMessage(error) });
    return;
  }
  const retryInSeconds = backOff(target, intervalMs, null);
  log.warn('fetch failed', { ...fields, error: errorMessage(error), retryInSeconds });
  recordFailure(store, target, null);
}

export async function runArchiver({
  intervalSeconds,
  dbPath,
  catalog,
  heartbeatUrl,
  peers = [],
  parquetDir,
  afterDays = DEFAULT_AFTER_DAYS,
  api3Url = BASE_URL,
  signal,
}: ArchiverOptions) {
  if (signal?.aborted) return;
  const intervalMs = intervalSeconds * 1000;
  const targets: Target[] = catalog.airnodes.flatMap(({ alias, airnode, signedApiUrl }) => {
    return ENDPOINTS.flatMap((endpoint) => {
      return SOURCES.map((source) => {
        const baseUrl = source === 'api3' ? api3Url : signedApiUrl;
        return { alias, airnode, endpoint, source, baseUrl, failures: 0, retryAt: 0, feeds: null };
      });
    });
  });
  // One request at a time, spread evenly across the interval, so the API sees a steady trickle.
  const gapMs = intervalMs / targets.length;
  const store = openStore(dbPath);

  // The first signal cancels the request in flight and the wait before the next one; a second exits at once.
  // Each save is one SQLite transaction, so even a forced exit leaves no half-written records.
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const handlers = (['SIGINT', 'SIGTERM'] as const).map((name) => {
    const handler = () => {
      if (stop.signal.aborted) {
        log.warn('forced stop', { signal: name });
        process.exit(name === 'SIGINT' ? 130 : 143);
      }
      log.info('stopping', { signal: name });
      stop.abort();
    };
    process.on(name, handler);
    return { name, handler };
  });

  log.info('archiver started', {
    providers: catalog.airnodes.length,
    targets: targets.length,
    intervalSeconds,
    db: dbPath,
    heartbeat: heartbeatUrl?.host,
    peers: peers.length,
    parquetDir,
    afterDays: parquetDir ? afterDays : undefined,
  });
  // Peer repair runs beside polling, never inside it, so a slow or unreachable peer can't hold up archiving. It stops
  // with the archiver and is waited for before the database closes.
  const repairing = peers.length > 0 ? runRepairs({ store, catalog, peers, intervalMs, signal: stop.signal }) : null;
  // Moving closed days to Parquet runs beside polling too, on its own connection, in small transactions.
  const moving = parquetDir ? runMoves({ dbPath, dir: parquetDir, afterDays, signal: stop.signal }) : null;
  while (!stop.signal.aborted) {
    const cycleStartedAt = Date.now();
    let saved = 0;
    let rejected = 0;
    let failed = 0;
    let backingOff = 0;
    let succeeded = 0;
    for (const target of targets) {
      if (stop.signal.aborted) break;
      const startedAt = performance.now();
      if (target.retryAt > startedAt) {
        backingOff += 1;
      } else {
        try {
          const result = await poll(target, store, intervalMs, stop.signal);
          if (result) {
            succeeded += 1;
            saved += result.saved;
            rejected += result.rejected;
          } else {
            failed += 1;
          }
        } catch (error) {
          if (stop.signal.aborted) break;
          failed += 1;
          noteFailure(store, target, intervalMs, error);
        }
      }
      try {
        await sleep(Math.max(0, gapMs - (performance.now() - startedAt)), undefined, { signal: stop.signal });
      } catch {
        break;
      }
    }
    log.info(stop.signal.aborted ? 'cycle interrupted' : 'cycle done', {
      saved,
      rejected,
      failed,
      backingOff,
      durationMs: Date.now() - cycleStartedAt,
    });
    // Only a cycle that reached the API counts as alive, so the monitor also alerts when every request fails.
    if (heartbeatUrl && succeeded > 0 && !stop.signal.aborted) await sendHeartbeat(heartbeatUrl);
  }
  await repairing;
  await moving;
  store.close();
  signal?.removeEventListener('abort', onAbort);
  for (const { name, handler } of handlers) process.off(name, handler);
  log.info('archiver stopped');
}
