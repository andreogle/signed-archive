import { setTimeout as sleep } from 'node:timers/promises';
import { type Address, isAddressEqual } from 'viem';
import {
  AIRNODES,
  BASE_URL,
  ENDPOINTS,
  type Endpoint,
  MAX_BACKOFF_MS,
  REQUEST_TIMEOUT_MS,
  SOURCES,
  type Source,
  USER_AGENT,
} from './config.ts';
import { sendHeartbeat } from './heartbeat.ts';
import { errorMessage, log } from './logger.ts';
import { hasValidSignature, type SignedDatum, toSignedDatum } from './signed-data.ts';
import { openStore } from './store.ts';

interface Target {
  alias: string;
  airnode: Address;
  endpoint: Endpoint;
  source: Source;
  // Signed API base URL for this source: API3's, or the provider's own.
  baseUrl: string;
  failures: number;
  retryAt: number;
  // Template IDs seen so far; null until the first successful fetch.
  feeds: Set<string> | null;
}

type Store = ReturnType<typeof openStore>;

export interface ArchiverOptions {
  intervalSeconds: number;
  dbPath: string;
  heartbeatUrl?: URL | undefined;
}

function backOff(target: Target, intervalMs: number, retryAfter: string | null) {
  target.failures += 1;
  const retryAfterMs = Number(retryAfter) * 1000;
  const delay = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : intervalMs * 2 ** target.failures;
  target.retryAt = Date.now() + Math.min(delay, MAX_BACKOFF_MS);
  return Math.round((target.retryAt - Date.now()) / 1000);
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
function recordFailure(store: Store, target: Target, status: number | null) {
  store.save([], {
    airnode: target.airnode,
    endpoint: target.endpoint,
    source: target.source,
    fetchedAt: Date.now(),
    status,
    received: 0,
    rejected: 0,
  });
}

async function poll(target: Target, store: Store, intervalMs: number, stop: AbortSignal) {
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
  const body: unknown = await response.json();
  const raw = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined;
  if (typeof raw !== 'object' || raw === null) throw new Error('response has no data object');

  const valid = [];
  let rejected = 0;
  for (const value of Object.values(raw)) {
    const datum = toSignedDatum(value);
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

export async function runArchiver({ intervalSeconds, dbPath, heartbeatUrl }: ArchiverOptions) {
  const intervalMs = intervalSeconds * 1000;
  const targets: Target[] = AIRNODES.flatMap(({ alias, airnode, signedApiUrl }) => {
    return ENDPOINTS.flatMap((endpoint) => {
      return SOURCES.map((source) => {
        const baseUrl = source === 'api3' ? BASE_URL : signedApiUrl;
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
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stop.signal.aborted) {
        log.warn('forced stop', { signal });
        process.exit(signal === 'SIGINT' ? 130 : 143);
      }
      log.info('stopping', { signal });
      stop.abort();
    });
  }

  log.info('archiver started', {
    providers: AIRNODES.length,
    targets: targets.length,
    intervalSeconds,
    db: dbPath,
    heartbeat: heartbeatUrl?.host,
  });
  while (!stop.signal.aborted) {
    const cycleStartedAt = Date.now();
    let saved = 0;
    let rejected = 0;
    let failed = 0;
    let backingOff = 0;
    let succeeded = 0;
    for (const target of targets) {
      if (stop.signal.aborted) break;
      const startedAt = Date.now();
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
          recordFailure(store, target, null);
          const retryInSeconds = backOff(target, intervalMs, null);
          log.warn('fetch failed', {
            ...fieldsOf(target),
            error: errorMessage(error),
            retryInSeconds,
          });
        }
      }
      try {
        await sleep(Math.max(0, gapMs - (Date.now() - startedAt)), undefined, { signal: stop.signal });
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
  store.close();
  log.info('archiver stopped');
}
