import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatConflicts, summarizeConflicts } from '../src/conflicts.ts';
import { openReader } from '../src/reader.ts';
import { hasValidSignature } from '../src/signed-data.ts';
import { openStore } from '../src/store.ts';
import { blocksize, catalog, coingecko, zecConflict } from './fixtures.ts';

const dir = mkdtempSync(join(tmpdir(), 'signed-archive-conflicts-'));
const [fromApi3, fromProvider] = zecConflict;

// An archive where API3's Signed API served one ZEC/USD value and blocksize's own served the other, for the same
// second, plus two ordinary ETH/USD records from blocksize.
function archive() {
  const path = join(dir, 'archive.sqlite');
  const store = openStore(path);
  const poll = { airnode: fromApi3.airnode, endpoint: 'public', status: 200, received: 1, rejected: 0 } as const;
  store.save([fromApi3, ...blocksize], { ...poll, source: 'api3', fetchedAt: 1_793_219_975_396 });
  store.save([fromProvider], { ...poll, source: 'provider', fetchedAt: 1_793_219_977_006 });
  // Synthetic: two coingecko values for one second, added as if merged from another archive, so no poll matches them
  // and their source is unknown. The summary reads stored rows and never re-checks signatures, so these needn't verify.
  const other = {
    ...coingecko,
    encodedValue: `0x${(BigInt(coingecko.encodedValue) * 2n).toString(16).padStart(64, '0')}`,
  };
  store.add(
    [coingecko, other as typeof coingecko].map((datum) => ({ datum, endpoint: 'public' as const, fetchedAt: 1 })),
    []
  );
  store.close();
  return path;
}

const path = archive();
const reader = openReader(path);

afterAll(() => {
  reader.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('summarizeConflicts', () => {
  test('the fixtures are a real conflict: two valid signatures over different values for one second', async () => {
    expect(fromApi3.timestamp).toBe(fromProvider.timestamp);
    expect(fromApi3.encodedValue).not.toBe(fromProvider.encodedValue);
    for (const datum of zecConflict) expect(await hasValidSignature(datum)).toBe(true);
  });

  test('counts the conflict per provider and endpoint, with its spread and the two Signed APIs that served it', () => {
    const all = summarizeConflicts(reader, catalog, 1, 1_800_000_000);
    const summary = all.find(({ provider }) => provider === 'blocksize');
    // Three distinct moments archived for blocksize: two ETH/USD, one ZEC/USD (with two values).
    expect(summary).toMatchObject({
      provider: 'blocksize',
      endpoint: 'public',
      moments: 3,
      conflicts: 1,
      sources: { 'api3+provider': 1 },
      widest: { feed: 'ZEC/USD', timestamp: 1_793_219_956 },
    });
    // 1287.5045085 and 1287.5167252: (higher - lower) / their mean is 0.0949 bps, truncated to two decimals.
    expect(summary?.spreadBps.max).toBe(0.09);
    expect(summary?.spreadBps.median).toBe(summary?.spreadBps.max ?? -1);
    expect(summary?.widest.values).toHaveLength(2);
  });

  test('marks records with no matching poll as from an unknown source, and lists providers alphabetically on a tie', () => {
    const all = summarizeConflicts(reader, catalog, 1, 1_800_000_000);
    expect(all.map(({ provider }) => provider)).toEqual(['blocksize', 'coingecko']);
    // Doubling the value is a 6667 bps spread around the mean of the two.
    expect(all[1]).toMatchObject({ conflicts: 1, sources: { unknown: 1 }, spreadBps: { max: 6666.66 } });
  });

  test('finds nothing outside the range asked for', () => {
    expect(summarizeConflicts(reader, catalog, 1_793_219_957, 1_800_000_000)).toEqual([]);
  });
});

describe('formatConflicts', () => {
  test('prints a table and the widest conflict, or says there were none', () => {
    const text = formatConflicts(summarizeConflicts(reader, catalog, 1, 1_800_000_000), 1, 1_800_000_000);
    expect(text).toContain('blocksize');
    expect(text).toContain('api3+provider 1');
    expect(text).toContain('ZEC/USD at 2026-10-28');
    expect(formatConflicts([], 1, 2)).toStartWith('No conflicting values');
  });
});
