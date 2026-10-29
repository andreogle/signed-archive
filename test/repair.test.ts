import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleApi } from '../src/api.ts';
import { openReader } from '../src/reader.ts';
import { repairGaps } from '../src/repair.ts';
import { openStore } from '../src/store.ts';
import { blocksize, catalog, coingecko, fixtureDb } from './fixtures.ts';

// The peer holds the real fixture records (ETH/USD, signed 1793206903-1793206951) and was polling at 1793207000.
const peerDb = fixtureDb();
const peerReader = openReader(peerDb.path);
const peer = Bun.serve({ port: 0, fetch: (request) => handleApi(peerReader, catalog, new URL(request.url)) });
const peerUrl = new URL(peer.url);

// Peers that misbehave: answer a fixed body or status, and count requests.
function fakePeer(answer: () => Response) {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      requests += 1;
      return answer();
    },
  });
  return { url: new URL(server.url), requests: () => requests, stop: () => server.stop(true) };
}

const dir = mkdtempSync(join(tmpdir(), 'signed-archive-repair-'));
let archives = 0;
const intervalMs = 60_000;

// An archive that polled coingecko's base data at each time (unix seconds), so anything longer than 3 intervals
// between two of them is a closed gap.
function archiveWithPolls(...seconds: number[]) {
  archives += 1;
  const store = openStore(join(dir, `archive-${archives}.sqlite`));
  for (const at of seconds) {
    store.save([], {
      airnode: coingecko.airnode,
      endpoint: 'public',
      source: 'api3',
      fetchedAt: at * 1000,
      status: 200,
      received: 0,
      rejected: 0,
    });
  }
  return store;
}

const quiet = () => spyOn(process.stderr, 'write').mockImplementation(() => true);

afterAll(() => {
  void peer.stop(true);
  peerReader.close();
  peerDb.remove();
  rmSync(dir, { recursive: true, force: true });
});

describe('repairGaps', () => {
  test('fills a closed gap from a peer, once, and never asks that peer about it again', async () => {
    const stderr = quiet();
    // Down from 1793206800 to 1793207100: the peer's coingecko record at 1793206907 is inside.
    const store = archiveWithPolls(1_793_206_800, 1_793_207_100);
    const first = await repairGaps({ store, catalog, peers: [peerUrl], intervalMs, now: 1_793_207_200_000 });
    expect(first).toEqual({ requests: 1, added: 1, rejected: 0, unknown: 0 });
    expect(store.has(coingecko)).toBe(true);
    // Only the gap's airnode was asked for, so the peer's blocksize records stay where they are.
    expect(store.has(blocksize[0] ?? coingecko)).toBe(false);
    const repair = store.getRepair({
      airnode: coingecko.airnode.toLowerCase() as typeof coingecko.airnode,
      endpoint: 'public',
      gapFrom: 1_793_206_800_000,
      peer: peerUrl.href,
    });
    expect(repair).toMatchObject({ status: 'filled', records: 1 });

    expect(await repairGaps({ store, catalog, peers: [peerUrl], intervalMs, now: 1_793_207_300_000 })).toEqual({
      requests: 0,
      added: 0,
      rejected: 0,
      unknown: 0,
    });
    stderr.mockRestore();
    store.close();
  });

  test('asks a peer that missed the gap too once more, an hour later, then never again', async () => {
    const stderr = quiet();
    const store = archiveWithPolls(1_793_100_000, 1_793_100_120, 1_793_100_500);
    const now = 1_793_200_000_000;
    const key = {
      airnode: coingecko.airnode.toLowerCase() as typeof coingecko.airnode,
      endpoint: 'public' as const,
      gapFrom: 1_793_100_120_000,
      peer: peerUrl.href,
    };
    // 120 s is within three 60 s intervals; only the 380 s stretch is asked about. The peer wasn't polling then.
    expect(await repairGaps({ store, catalog, peers: [peerUrl], intervalMs, now })).toEqual({
      requests: 1,
      added: 0,
      rejected: 0,
      unknown: 0,
    });
    expect(store.getRepair(key)).toMatchObject({ status: 'pending', rechecked: true, watched: false });
    expect((await repairGaps({ store, catalog, peers: [peerUrl], intervalMs, now: now + 30 * 60_000 })).requests).toBe(
      0
    );
    expect((await repairGaps({ store, catalog, peers: [peerUrl], intervalMs, now: now + 61 * 60_000 })).requests).toBe(
      1
    );
    expect(store.getRepair(key)?.status).toBe('none');
    expect(
      (await repairGaps({ store, catalog, peers: [peerUrl], intervalMs, now: now + 24 * 3600_000 })).requests
    ).toBe(0);
    stderr.mockRestore();
    store.close();
  });

  test('takes a peer that was watching and has nothing at its word', async () => {
    const stderr = quiet();
    const fake = fakePeer(() => Response.json({ watched: true, records: [] }));
    const store = archiveWithPolls(1_793_100_000, 1_793_100_500);
    await repairGaps({ store, catalog, peers: [fake.url], intervalMs, now: 1_793_200_000_000 });
    const key = {
      airnode: coingecko.airnode.toLowerCase() as typeof coingecko.airnode,
      endpoint: 'public' as const,
      gapFrom: 1_793_100_000_000,
      peer: fake.url.href,
    };
    expect(store.getRepair(key)).toMatchObject({ status: 'none', rechecked: false, watched: true });
    void fake.stop();
    stderr.mockRestore();
    store.close();
  });

  test('records only the stretch the records cover, so the rest of a partly filled gap stays a gap', async () => {
    const stderr = quiet();
    // blocksize, down for 1400 s; the peer holds two of its records, 48 s apart.
    const [first, second] = blocksize;
    if (!first || !second) throw new Error('fixtures need two blocksize records');
    const fake = fakePeer(() => Response.json({ watched: true, records: [first, second] }));
    archives += 1;
    const path = join(dir, `archive-${archives}.sqlite`);
    const store = openStore(path);
    for (const at of [1_793_206_000, 1_793_207_400]) {
      store.save([], {
        airnode: first.airnode,
        endpoint: 'public',
        source: 'api3',
        fetchedAt: at * 1000,
        status: 200,
        received: 0,
        rejected: 0,
      });
    }
    await repairGaps({ store, catalog, peers: [fake.url], intervalMs, now: 1_793_208_000_000 });
    store.close();
    const reader = openReader(path);
    // 48 s of 1400 s are covered; the stretches either side are longer than the gap threshold, so both stay shaded.
    expect(reader.gaps(1_793_206_000, 1_793_207_400)).toEqual([
      { from: 1_793_206_000, to: 1_793_206_903 },
      { from: 1_793_206_951, to: 1_793_207_400 },
    ]);
    reader.close();
    void fake.stop();
    stderr.mockRestore();
  });

  test('splits a long gap into windows the peer accepts', async () => {
    const stderr = quiet();
    const fake = fakePeer(() => Response.json({ watched: false, records: [] }));
    // 2000 s, plus the minute before it, is three 900 s windows.
    const store = archiveWithPolls(1_793_000_000, 1_793_002_000);
    expect(await repairGaps({ store, catalog, peers: [fake.url], intervalMs, now: 1_793_100_000_000 })).toMatchObject({
      requests: 3,
    });
    expect(fake.requests()).toBe(3);
    void fake.stop();
    stderr.mockRestore();
    store.close();
  });

  test('keeps only genuine records for the asked airnode and window', async () => {
    const stderr = quiet();
    const forged: typeof coingecko = { ...coingecko, encodedValue: `0x${'00'.repeat(31)}01` };
    const otherAirnode = blocksize[0];
    const outsideWindow = { ...coingecko, timestamp: '1700000000' };
    // A template this archive doesn't know isn't suspicious, just out of scope, so it isn't counted as rejected.
    const unknownTemplate: typeof coingecko = { ...coingecko, templateId: `0x${'ab'.repeat(32)}` };
    const fake = fakePeer(() =>
      Response.json({
        watched: true,
        records: [forged, otherAirnode, outsideWindow, 'junk', unknownTemplate, coingecko],
      })
    );
    const store = archiveWithPolls(1_793_206_800, 1_793_207_100);
    expect(await repairGaps({ store, catalog, peers: [fake.url], intervalMs, now: 1_793_207_200_000 })).toEqual({
      requests: 1,
      added: 1,
      rejected: 4,
      unknown: 1,
    });
    expect(store.has(unknownTemplate)).toBe(false);
    expect(store.has(coingecko)).toBe(true);
    expect(store.has(forged)).toBe(false);
    void fake.stop();
    stderr.mockRestore();
    store.close();
  });

  test('retries an unreachable or failing peer with backoff, then gives up; a refusal is final at once', async () => {
    const stderr = quiet();
    const down = new URL('http://127.0.0.1:1/');
    const store = archiveWithPolls(1_793_206_800, 1_793_207_100);
    const now = 1_793_207_200_000;
    const key = {
      airnode: coingecko.airnode.toLowerCase() as typeof coingecko.airnode,
      endpoint: 'public' as const,
      gapFrom: 1_793_206_800_000,
      peer: down.href,
    };
    expect((await repairGaps({ store, catalog, peers: [down], intervalMs, now })).requests).toBe(1);
    // Not due yet: the first retry waits 5 minutes.
    expect((await repairGaps({ store, catalog, peers: [down], intervalMs, now: now + 60_000 })).requests).toBe(0);
    expect((await repairGaps({ store, catalog, peers: [down], intervalMs, now: now + 6 * 60_000 })).requests).toBe(1);
    expect((await repairGaps({ store, catalog, peers: [down], intervalMs, now: now + 60 * 60_000 })).requests).toBe(1);
    expect(store.getRepair(key)).toMatchObject({ status: 'failed', attempts: 3 });
    expect(
      (await repairGaps({ store, catalog, peers: [down], intervalMs, now: now + 24 * 60 * 60_000 })).requests
    ).toBe(0);

    const busy = fakePeer(() => new Response('busy', { status: 503 }));
    const refusing = fakePeer(() => Response.json({ error: 'not found' }, { status: 404 }));
    const notJson = fakePeer(() => Response.json({ nope: true }));
    await repairGaps({ store, catalog, peers: [busy.url, refusing.url, notJson.url], intervalMs, now });
    expect(store.getRepair({ ...key, peer: busy.url.href })).toMatchObject({ status: 'pending', attempts: 1 });
    expect(store.getRepair({ ...key, peer: refusing.url.href })).toMatchObject({ status: 'failed', attempts: 0 });
    expect(store.getRepair({ ...key, peer: notJson.url.href })).toMatchObject({ status: 'pending', attempts: 1 });
    for (const fake of [busy, refusing, notJson]) void fake.stop();
    stderr.mockRestore();
    store.close();
  });
});

describe('GET /api/records', () => {
  const get = (query: string) =>
    handleApi(peerReader, catalog, new URL(`http://x/api/records?${query}`), 1_793_300_000);

  test('returns the signed records in the window and whether this archive was watching', async () => {
    const response = get(`airnode=${coingecko.airnode}&endpoint=public&from=1793206900&to=1793207000`);
    const body = await response.json();
    expect(body).toMatchObject({ watched: true, records: [coingecko] });
    const before = await get(`airnode=${coingecko.airnode}&endpoint=public&from=1793100000&to=1793100100`).json();
    expect(before).toMatchObject({ watched: false, records: [] });
  });

  test('refuses unknown airnodes and windows that are missing, reversed or too long', () => {
    expect(get('airnode=0x0000000000000000000000000000000000000001&from=1&to=2').status).toBe(404);
    expect(get(`airnode=${coingecko.airnode}&to=2`).status).toBe(400);
    expect(get(`airnode=${coingecko.airnode}&from=5&to=2`).status).toBe(400);
    expect(get(`airnode=${coingecko.airnode}&from=0&to=901`).status).toBe(400);
  });
});
