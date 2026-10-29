import { isAddressEqual } from 'viem';
import { PEER_WINDOW_SECONDS } from './api.ts';
import type { Catalog } from './catalog.ts';
import { type Endpoint, REQUEST_TIMEOUT_MS, USER_AGENT } from './config.ts';
import { errorMessage, log } from './logger.ts';
import { GAP_SECONDS } from './reader.ts';
import { hasValidSignature, type SignedDatum, toSignedDatum } from './signed-data.ts';
import type { Coverage, openStore, Repair } from './store.ts';

// Peer repair: after a gap closes, ask each configured peer for the records it holds from that stretch. A peer that
// was polling then and has nothing never gains it later (the Signed API only serves the latest value), so that answer
// is final. A peer that wasn't polling either may still fill the stretch from its own peers, so it is asked once more
// an hour later, and then never again. Only transient failures are retried, a few times with backoff. Peers are
// untrusted: every record is checked as if it came from the Signed API, and only records for the asked airnode,
// endpoint and window count. A gap stays a gap in `polls` (peers' coverage claims aren't signed); `repairs` records
// what was asked, and `peer_coverage` the stretches the peer's records actually cover.

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 5 * 60 * 1000;
// Requests per run, so a long outage is repaired over several runs instead of in one burst.
const REQUESTS_PER_RUN = 10;
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
// Base data is served about 15-25 s after it is signed, so a gap's records were signed a little before it started.
const SIGNED_BEFORE_FETCH_SECONDS = 60;
// Long enough for a peer that also missed the stretch to repair it from its own peers (they run every 10 minutes).
const RECHECK_AFTER_MS = 60 * 60 * 1000;

type Store = ReturnType<typeof openStore>;
type Gap = ReturnType<Store['closedGaps']>[number];

export interface RepairOptions {
  store: Store;
  catalog: Catalog;
  peers: readonly URL[];
  intervalMs: number;
  now?: number;
}

type Answer =
  | { kind: 'records'; data: unknown[]; watched: boolean }
  | { kind: 'retry'; error: string }
  | { kind: 'refused'; status: number };

async function ask(peer: URL, gap: Gap, from: number, to: number): Promise<Answer> {
  const url = new URL(`${peer.pathname.replace(/\/?$/, '/')}api/records`, peer);
  url.search = new URLSearchParams({
    airnode: gap.airnode,
    endpoint: gap.endpoint,
    from: String(from),
    to: String(to),
  }).toString();
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // A busy or broken peer may answer later; any other refusal (an old version without the route, a bad request) won't.
    if (response.status === 429 || response.status >= 500) return { kind: 'retry', error: `HTTP ${response.status}` };
    if (!response.ok) return { kind: 'refused', status: response.status };
    const body: unknown = await response.json();
    const records = typeof body === 'object' && body !== null ? (body as { records?: unknown }).records : undefined;
    if (!Array.isArray(records)) return { kind: 'retry', error: 'response has no records list' };
    return { kind: 'records', data: records, watched: (body as { watched?: unknown }).watched === true };
  } catch (error) {
    return { kind: 'retry', error: errorMessage(error) };
  }
}

// The checks a record from the Signed API gets, plus: it is for the gap's airnode and signed inside the window asked
// for. A well-formed record under a template this archive doesn't know (the peer's feed list differs, e.g. after a
// newer Dependabot bump) is not suspicious, just out of scope: it is counted apart from records that fail a check.
async function verify(catalog: Catalog, data: readonly unknown[], gap: Gap, from: number, to: number) {
  const templates = new Set(
    catalog.sourcesOfAirnode(gap.airnode, gap.endpoint).map(({ templateId }) => templateId.toLowerCase())
  );
  const valid: SignedDatum[] = [];
  let rejected = 0;
  let unknown = 0;
  for (const value of data) {
    const datum = toSignedDatum(value);
    const timestamp = Number(datum?.timestamp);
    const inScope =
      datum !== null && isAddressEqual(datum.airnode, gap.airnode) && timestamp >= from && timestamp <= to;
    if (inScope && !templates.has(datum.templateId.toLowerCase())) unknown += 1;
    else if (inScope && (await hasValidSignature(datum))) valid.push(datum);
    else rejected += 1;
  }
  return { valid, rejected, unknown };
}

// The stretches a set of records covers: consecutive records no further apart than the explorer's gap threshold
// belong to one stretch. A lone record covers nothing, because it says nothing about the time around it.
export function coverageOf(data: readonly SignedDatum[], gap: Gap, peer: URL): Coverage[] {
  const times = [...new Set(data.map(({ timestamp }) => Number(timestamp)))].sort((a, b) => a - b);
  const stretches: Coverage[] = [];
  for (const time of times) {
    const last = stretches.at(-1);
    if (last && time - last.to <= GAP_SECONDS) last.to = time;
    else
      stretches.push({
        airnode: gap.airnode,
        endpoint: gap.endpoint as Endpoint,
        from: time,
        to: time,
        peer: peer.href,
      });
  }
  return stretches.filter(({ from, to }) => to > from);
}

function fresh(gap: Gap, peer: URL): Repair {
  return {
    airnode: gap.airnode,
    endpoint: gap.endpoint as Endpoint,
    gapFrom: gap.from,
    gapTo: gap.to,
    peer: peer.href,
    status: 'pending',
    nextFrom: Math.floor(gap.from / 1000) - SIGNED_BEFORE_FETCH_SECONDS,
    attempts: 0,
    retryAt: 0,
    records: 0,
    watched: false,
    rechecked: false,
  };
}

// Works through closed gaps of the last week, at most REQUESTS_PER_RUN requests, and records progress so the next run
// continues where this one stopped.
export async function repairGaps({ store, catalog, peers, intervalMs, now = Date.now() }: RepairOptions) {
  let requests = 0;
  let added = 0;
  let rejected = 0;
  let unknown = 0;
  // A gap is missing more than a couple of polls, so ordinary jitter between requests never counts as one.
  for (const gap of store.closedGaps(now - LOOKBACK_MS, 3 * intervalMs)) {
    const gapEnd = Math.ceil(gap.to / 1000);
    const provider = catalog.aliasOf(gap.airnode) ?? gap.airnode;
    for (const peer of peers) {
      const repair =
        store.getRepair({ ...gap, endpoint: gap.endpoint as Endpoint, gapFrom: gap.from, peer: peer.href }) ??
        fresh(gap, peer);
      while (repair.status === 'pending' && repair.retryAt <= now && requests < REQUESTS_PER_RUN) {
        const to = Math.min(repair.nextFrom + PEER_WINDOW_SECONDS, gapEnd);
        requests += 1;
        const answer = await ask(peer, gap, repair.nextFrom, to);
        if (answer.kind === 'retry') {
          repair.attempts += 1;
          repair.retryAt = now + RETRY_BASE_MS * 2 ** (repair.attempts - 1);
          if (repair.attempts >= MAX_ATTEMPTS) repair.status = 'failed';
          log.warn('repair request failed', {
            provider,
            endpoint: gap.endpoint,
            peer: peer.host,
            error: answer.error,
            attempts: repair.attempts,
          });
          break;
        }
        if (answer.kind === 'refused') {
          repair.status = 'failed';
          log.warn('repair refused', { provider, endpoint: gap.endpoint, peer: peer.host, status: answer.status });
          break;
        }
        const checked = await verify(catalog, answer.data, gap, repair.nextFrom, to);
        const saved = store.add(
          checked.valid.map((datum) => ({ datum, endpoint: gap.endpoint as Endpoint, fetchedAt: Date.now() })),
          []
        );
        store.addCoverage(coverageOf(checked.valid, gap, peer));
        const fields = { provider, endpoint: gap.endpoint, peer: peer.host };
        if (checked.rejected > 0) log.warn('rejected records', { ...fields, rejected: checked.rejected });
        if (checked.unknown > 0) log.debug('unknown templates', { ...fields, records: checked.unknown });
        added += saved;
        rejected += checked.rejected;
        unknown += checked.unknown;
        repair.watched ||= answer.watched;
        repair.records += saved;
        repair.attempts = 0;
        repair.nextFrom = to + 1;
        if (to < gapEnd) continue;
        if (repair.records === 0 && !repair.watched && !repair.rechecked) {
          // The peer missed the stretch too; it may fill it from its own peers, so ask once more, later.
          Object.assign(repair, {
            rechecked: true,
            retryAt: now + RECHECK_AFTER_MS,
            nextFrom: fresh(gap, peer).nextFrom,
          });
          log.info('repair recheck scheduled', { ...fields, inMinutes: RECHECK_AFTER_MS / 60_000 });
          break;
        }
        repair.status = repair.records > 0 ? 'filled' : 'none';
        log.info('gap repaired', {
          ...fields,
          status: repair.status,
          records: repair.records,
          peerWatched: repair.watched,
          gapSeconds: Math.round((gap.to - gap.from) / 1000),
        });
      }
      store.putRepair(repair);
      if (requests >= REQUESTS_PER_RUN) return { requests, added, rejected, unknown };
    }
  }
  return { requests, added, rejected, unknown };
}
