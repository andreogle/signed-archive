import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FEEDS, isFeedRecord, PROVIDER_SLOTS } from '../src/feeds.ts';
import { decodeValue, median } from '../src/price.ts';
import { openReader } from '../src/reader.ts';
import { hasValidSignature } from '../src/signed-data.ts';
import { openStore } from '../src/store.ts';
import { blocksize, coingecko, coingeckoOev, fixtureDb } from './fixtures.ts';

const db = fixtureDb();
const reader = openReader(db.path);
const eth = FEEDS.get('ETH/USD');
if (!eth) throw new Error('ETH/USD missing from feeds.json');

afterAll(() => {
  reader.close();
  db.remove();
});

describe('FEEDS', () => {
  test('maps a feed name to each provider base and OEV template ID', () => {
    const base = eth.public.find(({ provider }) => provider === 'coingecko');
    const oev = eth['public-oev'].find(({ provider }) => provider === 'coingecko');
    expect(base).toEqual({ provider: 'coingecko', airnode: coingecko.airnode, templateId: coingecko.templateId });
    expect(oev?.templateId).toBe(coingeckoOev.templateId);
  });
});

describe('isFeedRecord', () => {
  test("accepts a provider's record for its own feed and endpoint", () => {
    expect(isFeedRecord('ETH/USD', 'public', { provider: 'coingecko', ...coingecko })).toBe(true);
    expect(isFeedRecord('ETH/USD', 'public-oev', { provider: 'coingecko', ...coingeckoOev })).toBe(true);
  });

  test('rejects a relabelled provider, a foreign signer, another feed or the other endpoint', () => {
    expect(isFeedRecord('ETH/USD', 'public', { provider: 'blocksize', ...coingecko })).toBe(false);
    const forged = { provider: 'coingecko', ...coingecko, airnode: '0x0000000000000000000000000000000000000001' };
    expect(isFeedRecord('ETH/USD', 'public', forged)).toBe(false);
    expect(isFeedRecord('BTC/USD', 'public', { provider: 'coingecko', ...coingecko })).toBe(false);
    expect(isFeedRecord('ETH/USD', 'public-oev', { provider: 'coingecko', ...coingecko })).toBe(false);
    expect(isFeedRecord('NOPE/USD', 'public', { provider: 'coingecko', ...coingecko })).toBe(false);
  });
});

describe('PROVIDER_SLOTS', () => {
  test('gives providers that share a feed different colour slots, within the 8-colour palette', () => {
    for (const [feed, { public: sources }] of FEEDS) {
      const slots = sources.map(({ provider }) => PROVIDER_SLOTS.get(provider));
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

describe('gaps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signed-archive-gaps-'));
  const path = join(dir, 'archive.sqlite');
  const store = openStore(path);
  // Polls at 1000 s and 1001 s, nothing for 499 s, then 1500 s; the archiver was down 1001-1500.
  for (const seconds of [1000, 1001, 1500]) {
    store.save([], {
      airnode: coingecko.airnode,
      endpoint: 'public',
      fetchedAt: seconds * 1000,
      status: 200,
      received: 0,
      rejected: 0,
    });
  }
  store.close();
  const gapReader = openReader(path);

  afterAll(() => {
    gapReader.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('reports stretches with no polls, but not time before the first poll', () => {
    expect(gapReader.gaps(0, 1600)).toEqual([{ from: 1001, to: 1500 }]);
  });

  test('reports the part of a gap inside the range when the gap starts before it or ends after it', () => {
    expect(gapReader.gaps(1200, 1600)).toEqual([{ from: 1200, to: 1500 }]);
    expect(gapReader.gaps(1100, 1300)).toEqual([{ from: 1100, to: 1300 }]);
    expect(gapReader.gaps(1002, 1003)).toEqual([{ from: 1002, to: 1003 }]);
  });

  test('reports a trailing gap when polling stopped before the end of the range', () => {
    expect(gapReader.gaps(0, 2000)).toEqual([
      { from: 1001, to: 1500 },
      { from: 1500, to: 2000 },
    ]);
  });

  test('reports nothing before the first poll, or for an archive made before polls were recorded', () => {
    expect(reader.gaps(0, 10)).toEqual([]);
    const oldPath = join(dir, 'old.sqlite');
    const old = new Database(oldPath, { create: true });
    old.run(
      'CREATE TABLE datapoints (airnode BLOB, template_id BLOB, timestamp INTEGER, value BLOB, signature BLOB, endpoint TEXT, fetched_at INTEGER)'
    );
    old.close();
    const oldReader = openReader(oldPath);
    expect(oldReader.gaps(0, 2000)).toEqual([]);
    oldReader.close();
  });
});
