import { type Address, isAddressEqual } from 'viem';
import {
  AIRNODES,
  BASE_URL,
  DB_PATH,
  ENDPOINTS,
  type Endpoint,
  MAX_BACKOFF_MS,
  POLL_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  USER_AGENT,
} from './config.ts';
import { hasValidSignature, toSignedDatum } from './signed-data.ts';
import { openStore } from './store.ts';

interface Target {
  airnode: Address;
  endpoint: Endpoint;
  path: string;
  failures: number;
  retryAt: number;
}

const targets: Target[] = AIRNODES.flatMap((airnode) =>
  ENDPOINTS.map((endpoint) => ({ airnode, endpoint, path: `${endpoint}/${airnode}`, failures: 0, retryAt: 0 }))
);
// One request at a time, spread evenly across the interval, so the API sees a steady trickle.
const gapMs = POLL_INTERVAL_MS / targets.length;
const store = openStore(DB_PATH);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

function backOff(target: Target, retryAfter: string | null) {
  target.failures += 1;
  const retryAfterMs = Number(retryAfter) * 1000;
  const delay =
    Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : POLL_INTERVAL_MS * 2 ** target.failures;
  target.retryAt = Date.now() + Math.min(delay, MAX_BACKOFF_MS);
}

async function poll(target: Target): Promise<{ saved: number; rejected: number }> {
  const response = await fetch(`${BASE_URL}/${target.path}`, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    backOff(target, response.headers.get('retry-after'));
    console.warn(`${target.path}: HTTP ${response.status}, retrying in ${(target.retryAt - Date.now()) / 1000}s`);
    return { saved: 0, rejected: 0 };
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
  target.failures = 0;
  return { saved: store.save(valid, target.endpoint, Date.now()), rejected };
}

console.info(`Polling ${targets.length} targets every ${POLL_INTERVAL_MS / 1000}s into ${DB_PATH}`);
while (!stopping) {
  let saved = 0;
  let rejected = 0;
  for (const target of targets) {
    if (stopping) break;
    const startedAt = Date.now();
    if (target.retryAt <= startedAt) {
      try {
        const result = await poll(target);
        saved += result.saved;
        rejected += result.rejected;
      } catch (error) {
        backOff(target, null);
        console.warn(`${target.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await Bun.sleep(Math.max(0, gapMs - (Date.now() - startedAt)));
  }
  console.info(`cycle done: ${saved} new datapoints, ${rejected} rejected`);
}
store.close();
