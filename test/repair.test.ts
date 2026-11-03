import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Address } from 'viem';
import { handleApi } from '../src/api.ts';
import { createCatalog } from '../src/catalog.ts';
import type { Endpoint } from '../src/config.ts';
import { GAP_SECONDS, openReader } from '../src/reader.ts';
import { coverageOf, repairNext, runRepairs, scheduleRepairs, windowsOf } from '../src/repair.ts';
import { openStore, type RepairWindow } from '../src/store.ts';
import { blocksize, catalog, coingecko, fixtureDb } from './fixtures.ts';

// The peer holds the real fixture records (ETH/USD, signed 1793206903-1793206951) and polled once, at 1793207000.
const peerDb = fixtureDb();
const peerReader = openReader(peerDb.path);
const peer = Bun.serve({ port: 0, fetch: (request) => handleApi(peerReader, catalog, new URL(request.url)) });
const peerUrl = new URL(peer.url);

// A peer that answers every request the same way, and remembers what it was asked.
function fakePeer(answer: () => Response | Promise<Response>) {
  const asked: URL[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      asked.push(new URL(request.url));
      return answer();
    },
  });
  return { url: new URL(server.url), asked, stop: () => server.stop(true) };
}
const answering = (body: Record<string, unknown>) => fakePeer(() => Response.json(body));

const dir = mkdtempSync(join(tmpdir(), 'signed-archive-repair-'));
let archives = 0;
const intervalMs = 60_000;
const airnode = coingecko.airnode.toLowerCase() as Address;

// An archive that polled `airnode`'s base data at each time (unix seconds); more than 3 intervals between two is a gap.
function archiveWithPolls(seconds: readonly number[], polled: Address = airnode) {
  archives += 1;
  const path = join(dir, `archive-${archives}.sqlite`);
  const store = openStore(path);
  for (const at of seconds) {
    store.save([], {
      airnode: polled,
      endpoint: 'public',
      source: 'api3',
      fetchedAt: at * 1000,
      status: 200,
      received: 0,
      rejected: 0,
    });
  }
  return { store, path };
}

type Store = ReturnType<typeof openStore>;

// Schedules, then asks about every due window, as the background loop would, at a fixed `now`.
async function drain(store: Store, peers: readonly URL[], now: number) {
  scheduleRepairs({ store, catalog, peers, intervalMs, now });
  const results = [];
  for (;;) {
    const result = await repairNext({ store, catalog, peers, now });
    if (!result) return results;
    results.push(result);
  }
}

const windowOf = (store: Store, from: number, peerHref: string) => {
  return store.getWindow({ airnode, endpoint: 'public', from, peer: peerHref });
};

let stderr: ReturnType<typeof spyOn>;
beforeAll(() => {
  stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterAll(() => {
  stderr.mockRestore();
  void peer.stop(true);
  peerReader.close();
  peerDb.remove();
  rmSync(dir, { recursive: true, force: true });
});

describe('windowsOf', () => {
  test('covers the gap plus 2 minutes either side, in inclusive windows of at most 900 s that never overlap', () => {
    expect(windowsOf({ from: 1_000_000, to: 1_300_000 })).toEqual([{ from: 880, to: 1420 }]);
    expect(windowsOf({ from: 1_000_000, to: 3_000_000 })).toEqual([
      { from: 880, to: 1780 },
      { from: 1781, to: 2681 },
      { from: 2682, to: 3120 },
    ]);
  });
});

describe('repair', () => {
  test('a bad signature cannot hide a genuine record later in the response', async () => {
    const bad = { ...coingecko, signature: `0x${'00'.repeat(65)}` };
    const fake = answering({ uncovered: [], records: [bad, coingecko, bad, coingecko] });
    const { store } = archiveWithPolls([1_793_206_800, 1_793_207_100]);
    try {
      const [result] = await drain(store, [fake.url], 1_793_207_200_000);
      expect(result).toMatchObject({ added: 1, rejected: 1 });
      expect(store.has(coingecko)).toBe(true);
    } finally {
      void fake.stop();
      store.close();
    }
  });

  test('keeps a peer-reported hole when storing coverage between genuine records', async () => {
    const provider = blocksize[0]?.airnode;
    if (!provider) throw new Error('missing blocksize fixture');
    const fake = answering({ uncovered: [{ from: 1_793_206_920, to: 1_793_206_930 }], records: blocksize });
    const { store, path } = archiveWithPolls([1_793_206_800, 1_793_207_100], provider);
    try {
      await drain(store, [fake.url], 1_793_207_200_000);
      const db = new Database(path, { readonly: true });
      try {
        expect(db.query('SELECT "from", "to" FROM peer_coverage ORDER BY "from"').all()).toEqual([
          { from: 1_793_206_903, to: 1_793_206_920 },
          { from: 1_793_206_930, to: 1_793_206_951 },
        ]);
      } finally {
        db.close();
      }
    } finally {
      void fake.stop();
      store.close();
    }
  });

  test('fills a gap from a peer, and asks again only because the peer missed part of the window too', async () => {
    // Down from 1793206800 to 1793207100; the peer's coingecko record at 1793206907 is inside. The peer itself only
    // polled once, at 1793207000, so it reports most of the window as missing on its side too.
    const { store } = archiveWithPolls([1_793_206_800, 1_793_207_100]);
    const now = 1_793_207_200_000;
    const [first, ...rest] = await drain(store, [peerUrl], now);
    expect(rest).toEqual([]);
    expect(first).toMatchObject({ outcome: 'recheck', added: 1 });
    expect(store.has(coingecko)).toBe(true);
    // Only the gap's airnode was asked for, so the peer's blocksize records stay where they are.
    expect(store.has(blocksize[0] ?? coingecko)).toBe(false);

    expect(await drain(store, [peerUrl], now + 30 * 60_000)).toEqual([]);
    const [second] = await drain(store, [peerUrl], now + 61 * 60_000);
    expect(second).toMatchObject({ outcome: 'done', added: 0 });
    expect(await drain(store, [peerUrl], now + 24 * 3600_000)).toEqual([]);
    expect(windowOf(store, 1_793_206_680, peerUrl.href)).toMatchObject({ status: 'done', rechecked: true, records: 1 });
    store.close();
  });

  test('takes a peer that watched the whole window and has nothing at its word', async () => {
    const fake = answering({ uncovered: [], watched: true, records: [] });
    const { store } = archiveWithPolls([1_793_100_000, 1_793_100_500]);
    const results = await drain(store, [fake.url], 1_793_200_000_000);
    expect(results.map(({ outcome }) => outcome)).toEqual(['done']);
    expect(await drain(store, [fake.url], 1_793_300_000_000)).toEqual([]);
    void fake.stop();
    store.close();
  });

  test('falls back to `watched` for a peer that does not report what it missed', async () => {
    const blind = answering({ watched: false, records: [] });
    const sighted = answering({ watched: true, records: [] });
    const { store } = archiveWithPolls([1_793_100_000, 1_793_100_500]);
    const results = await drain(store, [blind.url, sighted.url], 1_793_200_000_000);
    const byPeer = Object.fromEntries(results.map(({ window, outcome }) => [window.peer, outcome]));
    expect(byPeer).toEqual({ [blind.url.href]: 'recheck', [sighted.url.href]: 'done' });
    for (const fake of [blind, sighted]) void fake.stop();
    store.close();
  });

  test('finds an outage that started before the one-week lookback, whole', async () => {
    const now = 1_800_000_000_000;
    const day = 86_400;
    const { store } = archiveWithPolls([now / 1000 - 8 * day, now / 1000 - day]);
    const scheduled = scheduleRepairs({ store, catalog, peers: [peerUrl], intervalMs, now });
    expect(scheduled.gaps).toBe(1);
    // Seven days split into windows of at most 901 s each.
    expect(scheduled.windows).toBe(windowsOf({ from: now - 8 * day * 1000, to: now - day * 1000 }).length);
    expect(windowOf(store, now / 1000 - 8 * day - 120, peerUrl.href)?.status).toBe('pending');
    // Scheduling again adds nothing.
    expect(scheduleRepairs({ store, catalog, peers: [peerUrl], intervalMs, now }).windows).toBe(0);
    store.close();
  });

  test('asks about the newest window first, and skips windows another peer already covered', async () => {
    const fake = answering({ uncovered: [], watched: true, records: [] });
    const { store } = archiveWithPolls([1_793_000_000, 1_793_002_000]);
    scheduleRepairs({ store, catalog, peers: [fake.url], intervalMs, now: 1_793_100_000_000 });
    // The two older windows are already covered, say by another peer.
    store.addCoverage(
      [{ airnode, endpoint: 'public', from: 1_792_999_000, to: 1_793_001_700, peer: 'x' }],
      GAP_SECONDS
    );
    const results = [];
    for (;;) {
      const result = await repairNext({ store, catalog, peers: [fake.url], now: 1_793_100_000_000 });
      if (!result) break;
      results.push([result.window.from, result.outcome]);
    }
    expect(results).toEqual([
      [1_793_001_682, 'done'],
      [1_793_000_781, 'skipped'],
      [1_792_999_880, 'skipped'],
    ]);
    expect(fake.asked.map((url) => url.searchParams.get('from'))).toEqual(['1793001682']);
    void fake.stop();
    store.close();
  });

  test('asks another peer about a window whose coverage has a hole at its seam with the next window', async () => {
    const fake = answering({ uncovered: [], watched: true, records: [] });
    const { store } = archiveWithPolls([1_793_000_000, 1_793_002_000]);
    scheduleRepairs({ store, catalog, peers: [fake.url], intervalMs, now: 1_793_100_000_000 });
    // Another peer covered everything except 1793001500-1793001861, which straddles the seam at 1793001681/82.
    store.addCoverage(
      [
        { airnode, endpoint: 'public', from: 1_792_999_000, to: 1_793_001_500, peer: 'x' },
        { airnode, endpoint: 'public', from: 1_793_001_861, to: 1_793_003_000, peer: 'x' },
      ],
      GAP_SECONDS
    );
    const outcomes = [];
    for (;;) {
      const result = await repairNext({ store, catalog, peers: [fake.url], now: 1_793_100_000_000 });
      if (!result) break;
      outcomes.push([result.window.from, result.outcome]);
    }
    expect(outcomes).toEqual([
      [1_793_001_682, 'done'],
      [1_793_000_781, 'done'],
      [1_792_999_880, 'skipped'],
    ]);
    void fake.stop();
    store.close();
  });

  test('ignores polls dated in the future, which would open a gap reaching into it', () => {
    const now = 1_793_100_000_000;
    const { store } = archiveWithPolls([1_793_000_000, 1_793_000_060, 4_102_444_800]);
    expect(scheduleRepairs({ store, catalog, peers: [peerUrl], intervalMs, now })).toEqual({ gaps: 0, windows: 0 });
    store.close();
  });

  test('windows waiting on a removed or paused peer never crowd out a ready peer', async () => {
    const now = 1_793_500_000_000;
    const ready = answering({ uncovered: [], watched: true, records: [] });
    const gone = new URL('http://127.0.0.1:1/gone/');
    // A 6-day gap: over 500 windows per peer. The ready peer has already answered every window but the oldest.
    const { store, path } = archiveWithPolls([1_792_900_000, 1_793_420_000]);
    scheduleRepairs({ store, catalog, peers: [gone, ready.url], intervalMs, now });
    const db = new Database(path);
    db.run(`UPDATE repair_windows SET status = 'done' WHERE peer = ? AND "from" > 1792899880`, [ready.url.href]);
    db.close();
    const result = await repairNext({ store, catalog, peers: [ready.url], now });
    expect(result).toMatchObject({ outcome: 'done', window: { from: 1_792_899_880, peer: ready.url.href } });
    void ready.stop();
    store.close();
  });

  test('keeps only genuine, in-scope records, and checks each duplicate once', async () => {
    const forged: typeof coingecko = { ...coingecko, encodedValue: `0x${'00'.repeat(31)}01` };
    const outsideWindow = { ...coingecko, timestamp: '1700000000' };
    const unknownTemplate: typeof coingecko = { ...coingecko, templateId: `0x${'ab'.repeat(32)}` };
    const fake = answering({
      uncovered: [],
      records: [forged, blocksize[0], outsideWindow, 'junk', unknownTemplate, coingecko, coingecko, coingecko],
    });
    const { store } = archiveWithPolls([1_793_206_800, 1_793_207_100]);
    const [result] = await drain(store, [fake.url], 1_793_207_200_000);
    expect(result).toMatchObject({ outcome: 'done', added: 1, rejected: 4, unknown: 1 });
    expect(store.has(coingecko)).toBe(true);
    expect(store.has(forged)).toBe(false);
    void fake.stop();
    store.close();
  });

  test('retries transient failures with backoff and Retry-After, then gives up; some answers fail at once', async () => {
    const now = 1_793_207_200_000;
    const gap = [1_793_206_800, 1_793_207_100];
    const from = 1_793_206_680;
    const status = (code: number, headers: Record<string, string> = {}) => {
      return fakePeer(() => new Response('', { status: code, headers }));
    };

    // Unreachable: retried after 5, then 10 minutes, then given up.
    const down = new URL('http://127.0.0.1:1/');
    const a = archiveWithPolls(gap);
    await drain(a.store, [down], now);
    expect(windowOf(a.store, from, down.href)).toMatchObject({
      status: 'pending',
      attempts: 1,
      retryAt: now + 300_000,
    });
    expect(await drain(a.store, [down], now + 60_000)).toEqual([]);
    await drain(a.store, [down], now + 300_000);
    expect(windowOf(a.store, from, down.href)).toMatchObject({ attempts: 2, retryAt: now + 900_000 });
    await drain(a.store, [down], now + 900_000);
    expect(windowOf(a.store, from, down.href)).toMatchObject({ status: 'failed', attempts: 3 });
    a.store.close();

    // A rate limit waits as long as the peer asks; a 404 or 403 from a proxy mid-deploy is retried.
    const limited = status(429, { 'retry-after': '3600' });
    const missing = status(404);
    const forbidden = status(403);
    // A 400 will stay a 400, and a redirect could point anywhere: both fail at once.
    const bad = status(400);
    const redirecting = status(302, { location: 'http://169.254.169.254/' });
    const b = archiveWithPolls(gap);
    await drain(b.store, [limited.url, missing.url, forbidden.url, bad.url, redirecting.url], now);
    expect(windowOf(b.store, from, limited.url.href)).toMatchObject({ status: 'pending', retryAt: now + 3_600_000 });
    expect(windowOf(b.store, from, missing.url.href)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(windowOf(b.store, from, forbidden.url.href)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(windowOf(b.store, from, bad.url.href)?.status).toBe('failed');
    expect(windowOf(b.store, from, redirecting.url.href)?.status).toBe('failed');
    for (const fake of [limited, missing, forbidden, bad, redirecting]) void fake.stop();
    b.store.close();
  });

  test('pauses an unreachable peer as a whole, so its outage never uses up the attempts of every window', async () => {
    const now = 1_793_100_000_000;
    const down = new URL('http://127.0.0.1:1/');
    // A 2000 s gap: three windows waiting on the same peer.
    const { store } = archiveWithPolls([1_793_000_000, 1_793_002_000]);
    scheduleRepairs({ store, catalog, peers: [down], intervalMs, now });
    const health = new Map();
    const asked = [];
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      const result = await repairNext({ store, catalog, peers: [down], now: now + minute * 60_000, health });
      if (result) asked.push([minute, result.window.from, result.window.attempts]);
    }
    // Probes back off (5, 10, 20, 40 ... minutes, at most 6 hours) instead of trying every window each time.
    expect(asked.length).toBeLessThan(12);
    const counts = ['1792999880', '1793000781', '1793001682'].map((from) => windowOf(store, Number(from), down.href));
    // A day later no window has failed for good: each was charged at most once, while the peer was still healthy.
    for (const window of counts) expect(window?.status).toBe('pending');
    expect(counts.reduce((total, window) => total + (window?.attempts ?? 0), 0)).toBe(1);
    store.close();
  });

  test('refuses responses that are too large or hold too many records, and retries malformed ones', async () => {
    const now = 1_793_207_200_000;
    const huge = fakePeer(() => new Response(`{"records":[],"pad":"${'x'.repeat(17 * 1024 * 1024)}"}`));
    const many = answering({ records: Array.from({ length: 50_001 }, () => 0) });
    const garbled = fakePeer(() => new Response('{"records": ['));
    const listless = answering({ watched: true });
    const { store } = archiveWithPolls([1_793_206_800, 1_793_207_100]);
    await drain(store, [huge.url, many.url, garbled.url, listless.url], now);
    expect(windowOf(store, 1_793_206_680, huge.url.href)?.status).toBe('failed');
    expect(windowOf(store, 1_793_206_680, many.url.href)?.status).toBe('failed');
    expect(windowOf(store, 1_793_206_680, garbled.url.href)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(windowOf(store, 1_793_206_680, listless.url.href)).toMatchObject({ status: 'pending', attempts: 1 });
    for (const fake of [huge, many, garbled, listless]) void fake.stop();
    store.close();
  });

  test('leaves windows of peers no longer configured, and gaps of airnodes no longer configured, alone', async () => {
    const fake = answering({ uncovered: [], records: [] });
    const { store } = archiveWithPolls([1_793_206_800, 1_793_207_100]);
    scheduleRepairs({ store, catalog, peers: [fake.url], intervalMs, now: 1_793_207_200_000 });
    expect(await repairNext({ store, catalog, peers: [peerUrl], now: 1_793_207_200_000 })).toBeNull();
    const without = createCatalog({ airnodes: [], feeds: {} });
    const { store: other } = archiveWithPolls([1_793_206_800, 1_793_207_100]);
    expect(
      scheduleRepairs({ store: other, catalog: without, peers: [fake.url], intervalMs, now: 1_793_207_200_000 })
    ).toEqual({
      gaps: 0,
      windows: 0,
    });
    void fake.stop();
    store.close();
    other.close();
  });

  test('stops at once when the archiver stops, mid-request or while waiting', async () => {
    const hanging = fakePeer(() => new Promise<Response>(() => undefined));
    const { store } = archiveWithPolls([1_793_206_800, 1_793_207_100]);
    scheduleRepairs({ store, catalog, peers: [hanging.url], intervalMs, now: 1_793_207_200_000 });
    const stop = new AbortController();
    const started = Date.now();
    setTimeout(() => stop.abort(), 100);
    const result = await repairNext({
      store,
      catalog,
      peers: [hanging.url],
      now: 1_793_207_200_000,
      signal: stop.signal,
    });
    expect(result?.outcome).toBe('interrupted');
    expect(Date.now() - started).toBeLessThan(2000);
    // An interrupted request is not a failure: the window is untouched.
    expect(windowOf(store, 1_793_206_680, hanging.url.href)).toMatchObject({ status: 'pending', attempts: 0 });

    const looping = new AbortController();
    const loopStarted = Date.now();
    setTimeout(() => looping.abort(), 100);
    await runRepairs({ store, catalog, peers: [hanging.url], intervalMs, signal: looping.signal });
    expect(Date.now() - loopStarted).toBeLessThan(2000);
    void hanging.stop();
    store.close();
  });
});

describe('coverage', () => {
  const window: RepairWindow = {
    airnode,
    endpoint: 'public' as Endpoint,
    from: 0,
    to: 900,
    peer: 'p',
    status: 'pending',
    attempts: 0,
    retryAt: 0,
    rechecked: false,
    records: 0,
  };
  const at = (...seconds: number[]) => seconds.map((timestamp) => ({ ...coingecko, timestamp: String(timestamp) }));

  test('spans the verified records, split where they are more than the gap threshold apart, minus what the peer missed', () => {
    expect(coverageOf(window, at(100, 250, 400, 550, 700, 800), [])).toMatchObject([{ from: 100, to: 800 }]);
    expect(coverageOf(window, at(100, 250, 400, 550, 700, 800), [{ from: 450, to: 700 }])).toMatchObject([
      { from: 100, to: 450 },
      { from: 700, to: 800 },
    ]);
    expect(coverageOf(window, at(100, 200, 800), null)).toMatchObject([{ from: 100, to: 200 }]);
    expect(coverageOf(window, at(500), [])).toEqual([]);
  });

  test("never takes a peer's word for a stretch its records don't fill", () => {
    // Two genuine records 800 s apart and a claim of having missed nothing still cover nothing in between.
    expect(coverageOf(window, at(100, 900), [])).toEqual([]);
  });

  test('stretches from consecutive windows merge into one, so a window seam leaves no shading', () => {
    const { store, path } = archiveWithPolls([1000, 1001, 3000]);
    store.addCoverage([{ airnode, endpoint: 'public', from: 1001, to: 1800, peer: 'p' }], GAP_SECONDS);
    store.addCoverage([{ airnode, endpoint: 'public', from: 1850, to: 3000, peer: 'p' }], GAP_SECONDS);
    store.close();
    const reader = openReader(path);
    const [coingeckoSource] = catalog.sourcesOfAirnode(airnode, 'public');
    if (!coingeckoSource) throw new Error('coingecko has no ETH/USD source');
    expect(reader.gaps([coingeckoSource], 'public', 900, 3000)).toEqual([]);
    reader.close();
  });
});

describe('GET /api/records', () => {
  const response = (query: string) => {
    return handleApi(peerReader, catalog, new URL(`http://x/api/records?${query}`), 1_793_300_000);
  };
  const get = async (query: string) => (await response(query)).json();

  test('returns the signed records in the window and what this archive itself lacks there', async () => {
    const body = await get(`airnode=${coingecko.airnode}&endpoint=public&from=1793206900&to=1793207000`);
    expect(body.records).toEqual([coingecko]);
    // The peer's only poll was at 1793207000, so it lacks everything before it.
    expect(body).toMatchObject({ uncovered: [{ from: 1_793_206_900, to: 1_793_207_000 }], watched: false });
    const before = await get(`airnode=${coingecko.airnode}&endpoint=public&from=1793100000&to=1793100100`);
    expect(before).toMatchObject({
      records: [],
      uncovered: [{ from: 1_793_100_000, to: 1_793_100_100 }],
      watched: false,
    });
  });

  test('refuses unknown airnodes and windows that are missing, reversed or too long', async () => {
    // 400, which the asker treats as final: a peer that doesn't know an airnode won't learn it by being asked again.
    expect((await response('airnode=0x0000000000000000000000000000000000000001&from=1&to=2')).status).toBe(400);
    expect((await response(`airnode=${coingecko.airnode}&to=2`)).status).toBe(400);
    expect((await response(`airnode=${coingecko.airnode}&from=5&to=2`)).status).toBe(400);
    expect((await response(`airnode=${coingecko.airnode}&from=0&to=901`)).status).toBe(400);
  });
});
