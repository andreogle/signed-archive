import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeValue, median } from '../src/price.ts';
import { GAP_SECONDS, openReader } from '../src/reader.ts';
import { hasValidSignature } from '../src/signed-data.ts';
import { openStore } from '../src/store.ts';
import { blocksize, catalog, coingecko, coingeckoOev, fixtureDb } from './fixtures.ts';

const db = fixtureDb();
const reader = openReader(db.path);
const eth = catalog.feeds.get('ETH/USD');
if (!eth) throw new Error('ETH/USD missing from signed-archive.yaml');

afterAll(() => {
  reader.close();
  db.remove();
});

describe('catalog.feeds', () => {
  test('maps a feed name to each provider base and OEV template ID', () => {
    const base = eth.public.find(({ provider }) => provider === 'coingecko');
    const oev = eth['public-oev'].find(({ provider }) => provider === 'coingecko');
    expect(base).toEqual({ provider: 'coingecko', airnode: coingecko.airnode, templateId: coingecko.templateId });
    expect(oev?.templateId).toBe(coingeckoOev.templateId);
  });
});

describe('isFeedRecord', () => {
  test("accepts a provider's record for its own feed and endpoint", () => {
    expect(catalog.isFeedRecord('ETH/USD', 'public', { provider: 'coingecko', ...coingecko })).toBe(true);
    expect(catalog.isFeedRecord('ETH/USD', 'public-oev', { provider: 'coingecko', ...coingeckoOev })).toBe(true);
  });

  test('rejects a relabelled provider, a foreign signer, another feed or the other endpoint', () => {
    expect(catalog.isFeedRecord('ETH/USD', 'public', { provider: 'blocksize', ...coingecko })).toBe(false);
    const forged = { provider: 'coingecko', ...coingecko, airnode: '0x0000000000000000000000000000000000000001' };
    expect(catalog.isFeedRecord('ETH/USD', 'public', forged)).toBe(false);
    expect(catalog.isFeedRecord('BTC/USD', 'public', { provider: 'coingecko', ...coingecko })).toBe(false);
    expect(catalog.isFeedRecord('ETH/USD', 'public-oev', { provider: 'coingecko', ...coingecko })).toBe(false);
    expect(catalog.isFeedRecord('NOPE/USD', 'public', { provider: 'coingecko', ...coingecko })).toBe(false);
  });
});

describe('catalog.slots', () => {
  test('gives providers that share a feed different colour slots, within the 8-colour palette', () => {
    for (const [feed, { public: sources }] of catalog.feeds) {
      const slots = sources.map(({ provider }) => catalog.slots.get(provider));
      expect({ feed, distinct: new Set(slots).size }).toEqual({ feed, distinct: sources.length });
      for (const slot of slots) expect(slot).toBeLessThan(8);
    }
  });
});

describe('at', () => {
  test('returns each provider latest record at or before the time, still verifiable', async () => {
    const records = reader.at(eth.public, 1_793_206_910);
    expect(records.map(({ provider, timestamp }) => [provider, timestamp])).toEqual([
      ['blocksize', '1793206903'],
      ['coingecko', '1793206907'],
    ]);
    // Bytes read back must reproduce the signed fields exactly, or the archive stops being evidence.
    for (const record of records) expect(await hasValidSignature(record)).toBe(true);
    expect(records[1]).toMatchObject({ ...coingecko, price: '2333.11' });
  });

  test('picks the newest record when several are older than the time', () => {
    const [latest] = reader.at(eth.public, 1_793_207_000);
    expect(latest?.encodedValue).toBe(blocksize[1]?.encodedValue);
  });

  test('reads OEV records under the OEV template ID', () => {
    expect(reader.at(eth['public-oev'], 1_793_207_000).map(({ provider }) => provider)).toEqual(['coingecko']);
  });
});

describe('records', () => {
  test('returns every record in range, oldest first, still verifiable', async () => {
    const records = reader.records(eth.public, 1_793_206_900, 1_793_206_960);
    expect(records.map(({ provider, timestamp }) => [provider, timestamp])).toEqual([
      ['blocksize', '1793206903'],
      ['coingecko', '1793206907'],
      ['coinmetrics', '1793206912'],
      ['blocksize', '1793206951'],
    ]);
    for (const record of records) expect(await hasValidSignature(record)).toBe(true);
    expect(reader.records(eth.public, 1_793_206_904, 1_793_206_910).map(({ provider }) => provider)).toEqual([
      'coingecko',
    ]);
  });
});

describe('history', () => {
  test('returns ordered points per provider in range', () => {
    const providers = reader.history(eth.public, 1_793_206_900, 1_793_206_960);
    expect(providers.map(({ provider, points }) => [provider, points.map(({ timestamp }) => timestamp)])).toEqual([
      ['blocksize', [1_793_206_903, 1_793_206_951]],
      ['coingecko', [1_793_206_907]],
      ['coinmetrics', [1_793_206_912]],
    ]);
  });

  test('keeps the last record of each bucket on long ranges', () => {
    const [first] = reader.history(eth.public, 0, 1_793_207_000);
    expect(first?.points).toEqual([{ timestamp: 1_793_206_951, price: '2332.2122749432156' }]);
  });
});

describe('earliest', () => {
  test('returns the oldest record across sources, or null without records', () => {
    expect(reader.earliest(eth.public)).toBe(1_793_206_903);
    expect(reader.earliest([])).toBeNull();
  });
});

describe('median', () => {
  test('takes the middle value, or the mean of the two middle values rounded toward zero', () => {
    expect(median([3n, 1n, 2n])).toBe(2n);
    expect(median([4n, 1n, 2n, 3n])).toBe(2n);
    // Floor would give -3; Api3ServerV1 rounds toward zero.
    expect(median([-3n, -2n])).toBe(-2n);
    expect(median([5n])).toBe(5n);
    expect(median([])).toBeNull();
  });
});

describe('decodeValue', () => {
  test('reads values as signed int256', () => {
    expect(decodeValue(`0x${'f'.repeat(64)}`)).toBe(-1n);
  });
});

describe('gaps and uncovered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signed-archive-gaps-'));
  const source = (provider: string) => {
    const found = eth.public.find((entry) => entry.provider === provider);
    if (!found) throw new Error(`${provider} missing from ETH/USD`);
    return found;
  };
  const coingeckoSource = source('coingecko');
  const blocksizeSource = source('blocksize');
  let archives = 0;

  // An archive where each listed airnode was polled on `public` at the given seconds (status 200 unless negative).
  function archive(polls: Record<string, readonly number[]>, coverage: readonly [string, number, number][] = []) {
    archives += 1;
    const path = join(dir, `archive-${archives}.sqlite`);
    const store = openStore(path);
    for (const [airnode, seconds] of Object.entries(polls)) {
      for (const at of seconds) {
        store.save([], {
          airnode: airnode as typeof coingecko.airnode,
          endpoint: 'public',
          source: 'api3',
          fetchedAt: Math.abs(at) * 1000,
          status: at < 0 ? 503 : 200,
          received: 0,
          rejected: 0,
        });
      }
    }
    store.addCoverage(
      coverage.map(([airnode, from, to]) => {
        return { airnode: airnode as typeof coingecko.airnode, endpoint: 'public', from, to, peer: 'https://p/' };
      }),
      GAP_SECONDS
    );
    store.close();
    return openReader(path);
  }

  // coingecko polled at 1000, 1001 and 1500: down 1001-1500.
  const gapReader = archive({ [coingecko.airnode]: [1000, 1001, 1500] });
  const feed = [coingeckoSource];

  afterAll(() => {
    gapReader.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('reports stretches with no polls, but not time before the first poll', () => {
    expect(gapReader.gaps(feed, 'public', 0, 1600)).toEqual([{ from: 1001, to: 1500 }]);
  });

  test('reports the part of a gap inside the range when the gap starts before it or ends after it', () => {
    expect(gapReader.gaps(feed, 'public', 1200, 1600)).toEqual([{ from: 1200, to: 1500 }]);
    expect(gapReader.gaps(feed, 'public', 1100, 1300)).toEqual([{ from: 1100, to: 1300 }]);
    expect(gapReader.gaps(feed, 'public', 1002, 1003)).toEqual([{ from: 1002, to: 1003 }]);
  });

  test('reports a trailing gap when polling stopped before the end of the range', () => {
    // The outage and the stop after it touch at 1500, so they read as one stretch.
    expect(gapReader.gaps(feed, 'public', 0, 2000)).toEqual([{ from: 1001, to: 2000 }]);
  });

  test('counts a failed request as the archiver watching, since the provider was down, not the archiver', () => {
    // Failed requests every 100 s between successful ones at 1000 and 1400.
    const failing = archive({ [coingecko.airnode]: [1000, -1100, -1200, -1300, 1400] });
    expect(failing.gaps(feed, 'public', 1000, 1400)).toEqual([]);
    // A peer, though, is told it lacks the stretch: it got no data then.
    expect(failing.uncovered(coingecko.airnode, 'public', 1000, 1400)).toEqual([{ from: 1000, to: 1400 }]);
    failing.close();
  });

  test('hides only what a peer filled, and slivers under the gap threshold', () => {
    const filled = archive({ [coingecko.airnode]: [1000, 1001, 1500] }, [[coingecko.airnode, 1001, 1300]]);
    expect(filled.gaps(feed, 'public', 0, 1600)).toEqual([{ from: 1300, to: 1500 }]);
    filled.close();
    // Covered to 1400 leaves 100 s: covers are signed times, a little before the fetch that ended the gap.
    const sliver = archive({ [coingecko.airnode]: [1000, 1001, 1500] }, [[coingecko.airnode, 1001, 1400]]);
    expect(sliver.gaps(feed, 'public', 0, 1600)).toEqual([]);
    // Display smoothing must never widen the coverage we advertise to peers.
    expect(sliver.uncovered(coingecko.airnode, 'public', 1000, 1500)).toEqual([{ from: 1400, to: 1500 }]);
    // A short stretch no cover touches is still reported, e.g. a gap clipped by the range asked for.
    expect(sliver.gaps(feed, 'public', 1450, 1500)).toEqual([{ from: 1450, to: 1500 }]);
    sliver.close();
  });

  test("one provider's coverage never hides another provider's gap", () => {
    // Both were down 1001-1500; a peer filled blocksize only.
    const both = archive(
      { [coingecko.airnode]: [1000, 1001, 1500], [blocksize[0]?.airnode ?? '']: [1000, 1001, 1500] },
      [[blocksize[0]?.airnode ?? '', 1001, 1500]]
    );
    expect(both.gaps([blocksizeSource], 'public', 0, 1600)).toEqual([]);
    expect(both.gaps([coingeckoSource], 'public', 0, 1600)).toEqual([{ from: 1001, to: 1500 }]);
    // A feed with both providers stays shaded until every provider is covered.
    expect(both.gaps([coingeckoSource, blocksizeSource], 'public', 0, 1600)).toEqual([{ from: 1001, to: 1500 }]);
    // Coverage on one endpoint says nothing about the other.
    expect(both.gaps([blocksizeSource], 'public-oev', 0, 1600)).toEqual([]);
    both.close();
  });

  test("uncovered counts time before this archive's first poll, so a peer knows to ask again later", () => {
    expect(gapReader.uncovered(coingecko.airnode, 'public', 500, 1600)).toEqual([
      { from: 500, to: 1000 },
      { from: 1001, to: 1500 },
    ]);
    expect(gapReader.uncovered(blocksize[0]?.airnode ?? coingecko.airnode, 'public', 500, 600)).toEqual([
      { from: 500, to: 600 },
    ]);
  });

  test('lastPoll returns the newest request in unix milliseconds', () => {
    expect(gapReader.lastPoll()).toBe(1_500_000);
  });

  test('reports nothing before the first poll, or for an archive made before polls were recorded', () => {
    expect(reader.gaps(feed, 'public', 0, 10)).toEqual([]);
    const oldPath = join(dir, 'old.sqlite');
    const old = new Database(oldPath, { create: true });
    old.run(
      'CREATE TABLE datapoints (airnode BLOB, template_id BLOB, timestamp INTEGER, value BLOB, signature BLOB, endpoint TEXT, fetched_at INTEGER)'
    );
    old.close();
    const oldReader = openReader(oldPath);
    expect(oldReader.gaps(feed, 'public', 0, 2000)).toEqual([]);
    expect(oldReader.uncovered(coingecko.airnode, 'public', 0, 2000)).toEqual([{ from: 0, to: 2000 }]);
    expect(oldReader.lastPoll()).toBeNull();
    oldReader.close();
  });
});
