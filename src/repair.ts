import { setTimeout as sleep } from 'node:timers/promises';
import { isAddressEqual } from 'viem';
import { PEER_WINDOW_SECONDS } from './api.ts';
import type { Catalog } from './catalog.ts';
import { type Endpoint, isEndpoint, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS, USER_AGENT } from './config.ts';
import { readCapped, retryAfterMs } from './http.ts';
import { errorMessage, log } from './logger.ts';
import { GAP_SECONDS, type Gap, subtractCovered } from './reader.ts';
import { hasValidSignature, type SignedDatum, toSignedDatum } from './signed-data.ts';
import type { Coverage, openStore, RepairWindow } from './store.ts';

// Peer repair. A moment this archive missed can never be fetched from the Signed API again, but a peer that was
// polling then may hold it. Each closed gap is split once into windows of at most 15 minutes, and each window is asked
// of each peer independently, one request every few seconds, alongside polling and never blocking it.
//
// A peer that held the stretch answers with records; one that was polling and has nothing never gains it later (the
// Signed API only serves the latest value), so that answer is final. A peer that reports it missed part of the window
// too may fill it from its own peers, so that window is asked once more an hour later, then never again. Only
// transient failures are retried, a few times with backoff, honouring Retry-After. A window another peer already
// covered is skipped.
//
// Peers are untrusted. Every record is checked as if it came from the Signed API, and only records for the asked
// airnode, endpoint and window count. Responses are bounded in size and record count, duplicates are dropped before
// the (slow) signature check, and redirects are refused. A gap stays a gap in `polls` (peers' coverage claims aren't
// signed); `peer_coverage` records the stretches the peer's verified records span, which is what the explorer stops
// shading.

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 5 * 60 * 1000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;
// Gaps are looked for every 10 minutes; due windows are then asked one every 5 seconds, 12 a minute.
const SCHEDULE_EVERY_MS = 10 * 60 * 1000;
const REQUEST_SPACING_MS = 5_000;
const IDLE_MS = 60_000;
// Gaps that ended within the last week are scheduled; one that started earlier is still found whole.
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
// Windows extend past the gap on both sides. Base data is served about 15-25 s after it is signed, a provider's own
// Signed API may delay more, and clocks drift, so records signed during the gap can carry timestamps a little outside
// the fetch times that bound it. Records the archive already holds are simply not added again.
const WINDOW_MARGIN_SECONDS = 120;
// Long enough for a peer that also missed the stretch to repair it from its own peers.
const RECHECK_AFTER_MS = 60 * 60 * 1000;
// An honest window is at most a few thousand records (about 1 MB); these limits only stop a broken or hostile peer.
const MAX_RECORDS = 50_000;

type Store = ReturnType<typeof openStore>;

// How each peer is doing, by URL. A peer that fails is paused as a whole, so an outage on its side doesn't charge a
// failed attempt to every window waiting on it. Kept in memory: after a restart each peer is simply tried again.
export type PeerHealth = Map<string, { failures: number; pausedUntil: number }>;

export interface RepairOptions {
  store: Store;
  catalog: Catalog;
  peers: readonly URL[];
  now?: number;
  signal?: AbortSignal;
  health?: PeerHealth;
}

type Answer =
  | { kind: 'records'; data: unknown[]; uncovered: Gap[] | null; watched: boolean }
  | { kind: 'retry'; error: string; retryAfterMs: number | null }
  | { kind: 'refused'; reason: string };

const isGapList = (value: unknown): value is Gap[] => {
  return (
    Array.isArray(value) &&
    value.every((gap) => {
      return typeof gap === 'object' && gap !== null && Number.isFinite(gap.from) && Number.isFinite(gap.to);
    })
  );
};

async function ask(peer: URL, window: RepairWindow, now: number, signal?: AbortSignal): Promise<Answer> {
  const url = new URL(`${peer.pathname.replace(/\/?$/, '/')}api/records`, peer);
  url.search = new URLSearchParams({
    airnode: window.airnode,
    endpoint: window.endpoint,
    from: String(window.from),
    to: String(window.to),
  }).toString();
  try {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      // A redirect could point this archive at any host, including internal ones; a peer serves the route itself.
      redirect: 'manual',
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    // 400 means this request is wrong for the peer and will stay wrong; a redirect is refused above. Anything else
    // (rate limits, errors, an auth or not-found from a proxy mid-deploy) may pass, so it is retried.
    if (response.status === 400 || (response.status >= 300 && response.status < 400)) {
      return { kind: 'refused', reason: `HTTP ${response.status}` };
    }
    if (!response.ok) {
      const retryAfter = retryAfterMs(response.headers.get('retry-after'), now);
      return { kind: 'retry', error: `HTTP ${response.status}`, retryAfterMs: retryAfter };
    }
    const text = await readCapped(response, MAX_RESPONSE_BYTES);
    if (text === null) return { kind: 'refused', reason: `response over ${MAX_RESPONSE_BYTES} bytes` };
    const body: unknown = JSON.parse(text);
    const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    if (!Array.isArray(fields.records))
      return { kind: 'retry', error: 'response has no records list', retryAfterMs: null };
    if (fields.records.length > MAX_RECORDS) return { kind: 'refused', reason: `over ${MAX_RECORDS} records` };
    // Archives without the `uncovered` field only say whether they polled at all in the window.
    const uncovered = isGapList(fields.uncovered) ? fields.uncovered : null;
    return { kind: 'records', data: fields.records, uncovered, watched: fields.watched === true };
  } catch (error) {
    return { kind: 'retry', error: errorMessage(error), retryAfterMs: null };
  }
}

// The checks a record from the Signed API gets, plus: it is for the window's airnode and signed inside the window.
// Duplicates are dropped first, since the signature check is the slow step. A well-formed record under a template this
// archive doesn't know (the peer's feed list differs, e.g. after a newer Dependabot bump) is not suspicious, just out of
// scope: it is counted apart from records that fail a check.
async function verify(catalog: Catalog, data: readonly unknown[], window: RepairWindow) {
  const templates = new Set(
    catalog.sourcesOfAirnode(window.airnode, window.endpoint).map(({ templateId }) => templateId.toLowerCase())
  );
  const seen = new Set<string>();
  const valid: SignedDatum[] = [];
  let rejected = 0;
  let unknown = 0;
  for (const value of data) {
    const datum = toSignedDatum(value);
    const timestamp = Number(datum?.timestamp);
    const inScope =
      datum !== null &&
      isAddressEqual(datum.airnode, window.airnode) &&
      timestamp >= window.from &&
      timestamp <= window.to;
    if (!inScope) {
      rejected += 1;
      continue;
    }
    // A different signature is a different input: a forged copy must not hide the genuine record.
    const key = Object.values(datum).join(':').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!templates.has(datum.templateId.toLowerCase())) unknown += 1;
    else if (await hasValidSignature(datum)) valid.push(datum);
    else rejected += 1;
  }
  return { valid, rejected, unknown };
}

// The stretches a peer's verified records cover, in signed seconds: records more than GAP_SECONDS apart are separate
// stretches, so a peer can't claim a long stretch with a record at each end. Where the peer says it had nothing is
// left out too. A lone record covers nothing.
export function coverageOf(window: RepairWindow, valid: readonly SignedDatum[], uncovered: Gap[] | null): Coverage[] {
  const times = [...new Set(valid.map(({ timestamp }) => Number(timestamp)))].sort((a, b) => a - b);
  const dense: Gap[] = [];
  for (const time of times) {
    const current = dense.at(-1);
    if (current && time - current.to <= GAP_SECONDS) current.to = time;
    else dense.push({ from: time, to: time });
  }
  const stretches = uncovered ? subtractCovered(dense, uncovered) : dense;
  return stretches
    .filter(({ from, to }) => to > from)
    .map(({ from, to }) => ({ airnode: window.airnode, endpoint: window.endpoint, from, to, peer: window.peer }));
}

// Windows of at most PEER_WINDOW_SECONDS covering a gap (unix ms) plus WINDOW_MARGIN_SECONDS on both sides.
export function windowsOf(gap: { from: number; to: number }) {
  const end = Math.ceil(gap.to / 1000) + WINDOW_MARGIN_SECONDS;
  const windows: Gap[] = [];
  for (let from = Math.floor(gap.from / 1000) - WINDOW_MARGIN_SECONDS; from <= end; ) {
    const to = Math.min(from + PEER_WINDOW_SECONDS, end);
    windows.push({ from, to });
    from = to + 1;
  }
  return windows;
}

// Finds gaps that ended in the last week and records their windows for every peer. A gap already recorded adds
// nothing, so this is safe to run often. A gap for an airnode no longer configured, or a disabled endpoint, is skipped.
export function scheduleRepairs({
  store,
  catalog,
  peers,
  intervalMs,
  now = Date.now(),
}: RepairOptions & { intervalMs: number }) {
  // A gap is missing more than a couple of polls, so ordinary jitter between requests never counts as one. The
  // threshold never drops below the explorer's: history may have been polled less often than the archiver polls now,
  // and a shorter threshold would read every ordinary pause in it as an outage.
  const threshold = Math.max(3 * intervalMs, GAP_SECONDS * 1000);
  const gaps = store
    .closedGaps(now - LOOKBACK_MS, threshold, now)
    .filter(({ airnode, endpoint }) => isEndpoint(endpoint) && catalog.sourcesOfAirnode(airnode, endpoint).length > 0);
  const rows = gaps.flatMap((gap) => {
    return windowsOf(gap).flatMap(({ from, to }) => {
      return peers.map((peer) => ({
        airnode: gap.airnode,
        endpoint: gap.endpoint as Endpoint,
        from,
        to,
        peer: peer.href,
      }));
    });
  });
  return { gaps: gaps.length, windows: store.addWindows(rows) };
}

const fieldsOf = (catalog: Catalog, window: RepairWindow, peer: URL) => {
  return { provider: catalog.aliasOf(window.airnode) ?? window.airnode, endpoint: window.endpoint, peer: peer.host };
};

// Asks about the newest due window of a configured peer, and records the outcome. Returns null when nothing is due.
export async function repairNext({
  store,
  catalog,
  peers,
  now = Date.now(),
  signal,
  health = new Map(),
}: RepairOptions) {
  const byHref = new Map(peers.map((peer) => [peer.href, peer]));
  // Windows of peers removed from the config stay pending, untouched, in case the peer comes back. Windows of a
  // paused peer wait for the pause to end.
  const ready = [...byHref.keys()].filter((href) => (health.get(href)?.pausedUntil ?? 0) <= now);
  const [window] = store.dueWindows(now, 1, ready);
  const peer = window && byHref.get(window.peer);
  if (!window || !peer) return null;
  const fields = fieldsOf(catalog, window, peer);

  const known = catalog.sourcesOfAirnode(window.airnode, window.endpoint).length > 0;
  if (!known || store.isCovered(window, GAP_SECONDS)) {
    store.putWindow({ ...window, status: 'skipped' });
    return { window, outcome: 'skipped' as const, requested: false, added: 0, rejected: 0, unknown: 0 };
  }

  const answer = await ask(peer, window, now, signal);
  if (signal?.aborted)
    return { window, outcome: 'interrupted' as const, requested: true, added: 0, rejected: 0, unknown: 0 };
  if (answer.kind !== 'retry') health.delete(peer.href);
  if (answer.kind === 'refused') {
    store.putWindow({ ...window, status: 'failed' });
    log.warn('repair refused', { ...fields, reason: answer.reason });
    return { window, outcome: 'failed' as const, requested: true, added: 0, rejected: 0, unknown: 0 };
  }
  if (answer.kind === 'retry') {
    // The first failure from a healthy peer counts against the window, which may be what the peer can't serve. Later
    // ones, while the peer stays unreachable, only extend its pause: the window waits, uncharged.
    const state = health.get(peer.href) ?? { failures: 0, pausedUntil: 0 };
    const charged = state.failures === 0;
    state.failures += 1;
    const peerBackoff = RETRY_BASE_MS * 2 ** (state.failures - 1);
    state.pausedUntil = now + Math.min(Math.max(answer.retryAfterMs ?? 0, peerBackoff), MAX_RETRY_MS);
    health.set(peer.href, state);
    const attempts = window.attempts + (charged ? 1 : 0);
    const backoff = RETRY_BASE_MS * 2 ** (Math.max(attempts, 1) - 1);
    const delay = Math.min(Math.max(answer.retryAfterMs ?? 0, backoff), MAX_RETRY_MS);
    const failed = attempts >= MAX_ATTEMPTS;
    store.putWindow({ ...window, attempts, retryAt: now + delay, status: failed ? 'failed' : 'pending' });
    log.warn('repair request failed', {
      ...fields,
      error: answer.error,
      attempts,
      peerFailures: state.failures,
      retryInSeconds: failed ? undefined : delay / 1000,
    });
    const outcome = failed ? ('failed' as const) : ('retry' as const);
    return { window, outcome, requested: true, added: 0, rejected: 0, unknown: 0 };
  }

  const checked = await verify(catalog, answer.data, window);
  const added = store.add(
    checked.valid.map((datum) => ({ datum, endpoint: window.endpoint, fetchedAt: Date.now() })),
    []
  );
  // Only overlap may be merged; joining across a short hole would undo the peer's `uncovered` report.
  store.addCoverage(coverageOf(window, checked.valid, answer.uncovered), 0);
  if (checked.rejected > 0) log.warn('rejected records', { ...fields, rejected: checked.rejected });
  if (checked.unknown > 0) log.debug('unknown templates', { ...fields, records: checked.unknown });

  // The peer missed part of the window too: it may fill that from its own peers, so ask once more, later.
  const peerMissedPart = answer.uncovered ? answer.uncovered.length > 0 : !answer.watched;
  const recheck = peerMissedPart && !window.rechecked;
  store.putWindow({
    ...window,
    status: recheck ? 'pending' : 'done',
    attempts: 0,
    retryAt: recheck ? now + RECHECK_AFTER_MS : window.retryAt,
    rechecked: window.rechecked || recheck,
    records: window.records + added,
  });
  (added > 0 ? log.info : log.debug)('repair window', {
    ...fields,
    from: window.from,
    records: added,
    received: answer.data.length,
    recheck,
  });
  const outcome = recheck ? ('recheck' as const) : ('done' as const);
  return { window, outcome, requested: true, added, rejected: checked.rejected, unknown: checked.unknown };
}

export interface RepairLoopOptions {
  store: Store;
  catalog: Catalog;
  peers: readonly URL[];
  intervalMs: number;
  signal: AbortSignal;
  currentCatalog?: () => Catalog;
}

// Runs beside the archiver until `signal` aborts. Gaps are scheduled after the first polling cycle, which closes the
// gap a restart leaves, then every 10 minutes; due windows are asked one every few seconds. A failure in one step is
// logged and the loop carries on.
export async function runRepairs({
  store,
  catalog: initialCatalog,
  currentCatalog,
  peers,
  intervalMs,
  signal,
}: RepairLoopOptions) {
  let nextSchedule = Date.now() + intervalMs + REQUEST_SPACING_MS;
  const health: PeerHealth = new Map();
  while (!signal.aborted) {
    const catalog = currentCatalog?.() ?? initialCatalog;
    let worked = false;
    try {
      if (Date.now() >= nextSchedule) {
        const scheduled = scheduleRepairs({ store, catalog, peers, intervalMs });
        nextSchedule = Date.now() + SCHEDULE_EVERY_MS;
        if (scheduled.windows > 0) log.info('repair scheduled', { ...scheduled, ...store.windowCounts() });
      }
      const result = await repairNext({ store, catalog, peers, signal, health });
      worked = result !== null;
    } catch (error) {
      log.warn('repair step failed', { error: errorMessage(error) });
    }
    const wait = worked ? REQUEST_SPACING_MS : Math.min(IDLE_MS, Math.max(0, nextSchedule - Date.now()));
    try {
      await sleep(wait, undefined, { signal });
    } catch {
      break;
    }
  }
}
