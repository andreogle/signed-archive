import { type Address, isAddressEqual } from 'viem';
import {
  AIRNODES,
  BASE_URL,
  ENDPOINTS,
  type Endpoint,
  MAX_BACKOFF_MS,
  REQUEST_TIMEOUT_MS,
  USER_AGENT,
} from './config.ts';
import { errorMessage, log } from './logger.ts';
import { hasValidSignature, type SignedDatum, toSignedDatum } from './signed-data.ts';
import { openStore } from './store.ts';

interface Target {
  alias: string;
  airnode: Address;
  endpoint: Endpoint;
  failures: number;
  retryAt: number;
  // Template IDs seen so far; null until the first successful fetch.
  feeds: Set<string> | null;
}

type Store = ReturnType<typeof openStore>;

export interface ArchiverOptions {
  intervalSeconds: number;
  dbPath: string;
}

function backOff(target: Target, intervalMs: number, retryAfter: string | null) {
  target.failures += 1;
  const retryAfterMs = Number(retryAfter) * 1000;
  const delay = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : intervalMs * 2 ** target.failures;
  target.retryAt = Date.now() + Math.min(delay, MAX_BACKOFF_MS);
  return Math.round((target.retryAt - Date.now()) / 1000);
}

function trackFeeds(target: Target, data: readonly SignedDatum[]) {
  const fields = { provider: target.alias, endpoint: target.endpoint };
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

async function poll(target: Target, store: Store, intervalMs: number) {
  const fields = { provider: target.alias, endpoint: target.endpoint };
  const response = await fetch(`${BASE_URL}/${target.endpoint}/${target.airnode}`, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const retryInSeconds = backOff(target, intervalMs, response.headers.get('retry-after'));
    log.warn('fetch failed', { ...fields, status: response.status, retryInSeconds });
    return null;
  }
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
  const saved = store.save(valid, target.endpoint, Date.now());
  if (rejected > 0) log.warn('rejected records', { ...fields, rejected });
  log.debug('fetched', { ...fields, received: valid.length + rejected, saved });
  return { saved, rejected };
}

export async function runArchiver({ intervalSeconds, dbPath }: ArchiverOptions) {
  const intervalMs = intervalSeconds * 1000;
  const targets: Target[] = AIRNODES.flatMap(({ alias, airnode }) =>
    ENDPOINTS.map((endpoint) => ({ alias, airnode, endpoint, failures: 0, retryAt: 0, feeds: null }))
  );
  // One request at a time, spread evenly across the interval, so the API sees a steady trickle.
  const gapMs = intervalMs / targets.length;
  const store = openStore(dbPath);

  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (!stopping) log.info('stopping', { signal });
      stopping = true;
    });
  }

  log.info('archiver started', { providers: AIRNODES.length, targets: targets.length, intervalSeconds, db: dbPath });
  while (!stopping) {
    const cycleStartedAt = Date.now();
    let saved = 0;
    let rejected = 0;
    let failed = 0;
    let backingOff = 0;
    for (const target of targets) {
      if (stopping) break;
      const startedAt = Date.now();
      if (target.retryAt > startedAt) {
        backingOff += 1;
      } else {
        try {
          const result = await poll(target, store, intervalMs);
          if (result) {
            saved += result.saved;
            rejected += result.rejected;
          } else {
            failed += 1;
          }
        } catch (error) {
          failed += 1;
          const retryInSeconds = backOff(target, intervalMs, null);
          log.warn('fetch failed', {
            provider: target.alias,
            endpoint: target.endpoint,
            error: errorMessage(error),
            retryInSeconds,
          });
        }
      }
      await Bun.sleep(Math.max(0, gapMs - (Date.now() - startedAt)));
    }
    log.info(stopping ? 'cycle interrupted' : 'cycle done', {
      saved,
      rejected,
      failed,
      backingOff,
      durationMs: Date.now() - cycleStartedAt,
    });
  }
  store.close();
  log.info('archiver stopped');
}
