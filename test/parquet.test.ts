import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeedSource } from '../src/catalog.ts';
import { hashFileRows, moveDays } from '../src/parquet.ts';
import { openReader } from '../src/reader.ts';
import { hasValidSignature, type SignedDatum } from '../src/signed-data.ts';
import { backupArchive, openStore } from '../src/store.ts';
import { blocksize, catalog, coingecko, fixtureDb, zecConflict } from './fixtures.ts';

// Every fixture was signed on 2026-10-28 (UTC). That day ends at 2026-10-29 00:00, so with afterDays 7 it is due
// from 2026-11-05 00:00.
const DAY = '2026-10-28';
const beforeDue = Date.parse('2026-11-04T23:59:59Z');
const due = Date.parse('2026-11-05T00:00:00Z');

const feedSources = (feed: string) => {
  const found = catalog.feeds.get(feed);
  if (!found) throw new Error(`${feed} missing from the catalog`);
  return [...found.public, ...found['public-oev']];
};
const eth = feedSources('ETH/USD');
const zec = feedSources('ZEC/USD');

const count = (path: string, sql: string) => {
  const db = new Database(path, { readonly: true });
  const { n } = db.query<{ n: number }, []>(sql).get() ?? { n: -1 };
  db.close();
  return n;
};
const datapoints = (path: string) => count(path, 'SELECT count(*) AS n FROM datapoints');

// Adds records as merged ones (no poll), the way peer repair and merge do.
const add = (path: string, data: readonly SignedDatum[], fetchedAt: number) => {
  const store = openStore(path);
  store.add(
    data.map((datum) => ({ datum, endpoint: 'public' as const, fetchedAt })),
    []
  );
  store.close();
};

// Every question the explorer, API and MCP ask, so a move can be checked to change none of the answers.
async function answers(path: string, parquetDir: string) {
  const reader = openReader(path, { parquetDir });
  const sources: FeedSource[] = [...eth, ...zec];
  const result = {
    at: await Promise.all(
      [1_793_206_904, 1_793_206_910, 1_793_206_960, 1_793_219_956, 1_793_300_000].map((t) => reader.at(sources, t))
    ),
    records: await reader.records(sources, 0, 2_000_000_000),
    window: await reader.records(eth, 1_793_206_904, 1_793_206_920),
    history: await reader.history(eth, 1_793_206_000, 1_793_208_000, 3),
    earliest: reader.earliest(eth),
    conflicts: await reader.conflictRecords(sources, 0, 2_000_000_000),
    moments: await reader.momentCounts(sources, 0, 2_000_000_000),
  };
  reader.close();
  return result;
}

const dirs: string[] = [];
const setup = () => {
  const db = fixtureDb();
  const parquetDir = mkdtempSync(join(tmpdir(), 'signed-archive-parquet-'));
  dirs.push(parquetDir);
  add(db.path, [zecConflict[0]], 1_793_219_960_000);
  return { ...db, parquetDir };
};

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('moveDays', () => {
  test('moves a day only once it ended afterDays ago, and every answer stays the same', async () => {
    const { path, parquetDir, remove } = setup();
    const before = await answers(path, parquetDir);
    const rows = datapoints(path);

    expect(await moveDays({ dbPath: path, dir: parquetDir, now: beforeDue })).toEqual({
      files: [],
      written: 0,
      deleted: 0,
    });
    expect(datapoints(path)).toBe(rows);

    expect(await moveDays({ dbPath: path, dir: parquetDir, now: due })).toEqual({
      files: [`${DAY}.000.parquet`],
      written: rows,
      deleted: rows,
    });
    expect(datapoints(path)).toBe(0);
    expect(await answers(path, parquetDir)).toEqual(before);

    // The registered hash is the file's, and every row reads back and still verifies.
    const file = join(parquetDir, `${DAY}.000.parquet`);
    const sha256 = new Bun.CryptoHasher('sha256').update(await Bun.file(file).arrayBuffer()).digest('hex');
    expect(count(path, `SELECT count(*) AS n FROM parquet_files WHERE moved = 1 AND sha256 = '${sha256}'`)).toBe(1);
    const reader = openReader(path, { parquetDir });
    for (const record of await reader.records([...eth, ...zec], 0, 2_000_000_000)) {
      expect(await hasValidSignature(record)).toBe(true);
    }
    expect(reader.parquetFiles().map(({ name, rows: n }) => [name, n])).toEqual([[`${DAY}.000.parquet`, rows]]);
    reader.close();
    remove();
  });

  test('a record served again after its day moved is read once, and the next move only drops it', async () => {
    const { path, parquetDir, remove } = setup();
    await moveDays({ dbPath: path, dir: parquetDir, now: due });
    const moved = await answers(path, parquetDir);

    add(path, [coingecko], 1_793_300_000_000);
    expect(datapoints(path)).toBe(1);
    expect(await answers(path, parquetDir)).toEqual(moved);

    expect(await moveDays({ dbPath: path, dir: parquetDir, now: due })).toEqual({ files: [], written: 0, deleted: 1 });
    expect(datapoints(path)).toBe(0);
    expect(count(path, 'SELECT count(*) AS n FROM parquet_files')).toBe(1);
    remove();
  });

  test('a late record for a moved day goes to a new part file, and a conflict across stores is still found', async () => {
    const { path, parquetDir, remove } = setup();
    await moveDays({ dbPath: path, dir: parquetDir, now: due });

    // The second value blocksize signed for the same second arrives late, e.g. from a peer.
    add(path, [zecConflict[1]], 1_793_300_000_000);
    const reader = openReader(path, { parquetDir });
    const conflicted = async () => {
      return (await reader.at(zec, 1_793_219_956)).map(({ encodedValue }) => encodedValue);
    };
    const values = zecConflict.map(({ encodedValue }) => encodedValue).sort();
    expect(await conflicted()).toEqual(values);
    expect((await reader.conflictRecords(zec, 0, 2_000_000_000)).map(({ value }) => value)).toEqual(values);

    expect((await moveDays({ dbPath: path, dir: parquetDir, now: due })).files).toEqual([`${DAY}.001.parquet`]);
    expect(await conflicted()).toEqual(values);
    expect((await reader.momentCounts(zec, 0, 2_000_000_000)).map(({ moments }) => moments)).toEqual([1]);
    reader.close();
    remove();
  });

  test('splits a day into parts of at most maxRowsPerFile rows, each with its own key ranges', async () => {
    const { path, parquetDir, remove } = setup();
    const before = await answers(path, parquetDir);
    const result = await moveDays({ dbPath: path, dir: parquetDir, now: due, maxRowsPerFile: 2 });
    expect(result.files).toEqual([`${DAY}.000.parquet`, `${DAY}.001.parquet`, `${DAY}.002.parquet`]);
    expect(await answers(path, parquetDir)).toEqual(before);
    remove();
  });

  test('finishes clearing SQLite after a stop between registering a file and deleting its rows', async () => {
    const { path, parquetDir, remove } = setup();
    await moveDays({ dbPath: path, dir: parquetDir, now: due });
    // As if the process stopped right after registering: the rows are still in SQLite and the file is not moved.
    add(path, [...blocksize, coingecko], 1_793_207_000_000);
    const db = new Database(path);
    db.run('UPDATE parquet_files SET moved = 0');
    db.close();

    // A reader sees each record once meanwhile, and unmoved files are not offered for download.
    const reader = openReader(path, { parquetDir });
    expect(reader.parquetFiles()).toEqual([]);
    expect(await reader.records(eth, 0, 2_000_000_000)).toHaveLength(5);
    reader.close();

    expect(await moveDays({ dbPath: path, dir: parquetDir, now: beforeDue })).toEqual({
      files: [],
      written: 0,
      deleted: 3,
    });
    expect(datapoints(path)).toBe(0);
    expect(count(path, 'SELECT count(*) AS n FROM parquet_files WHERE moved = 1')).toBe(1);
    remove();
  });

  test('a file whose contents changed no longer hashes as registered', async () => {
    const { path, parquetDir, remove } = setup();
    await moveDays({ dbPath: path, dir: parquetDir, now: due });
    const file = join(parquetDir, `${DAY}.000.parquet`);
    const original = await hashFileRows(file);
    expect(original.rows).toBe(6);

    // Swap one signature byte for another: the file still parses, but the rows differ.
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
    const signature = Buffer.from(coingecko.signature.slice(2, 34), 'hex');
    const at = Buffer.from(bytes).indexOf(signature);
    expect(at).toBeGreaterThan(0);
    bytes[at] = (bytes[at] ?? 0) ^ 0xff;
    const tampered = join(parquetDir, 'tampered.parquet');
    await Bun.write(tampered, bytes);
    expect((await hashFileRows(tampered)).sha256).not.toBe(original.sha256);
    remove();
  });
});

describe('reader.parquetPath', () => {
  test('only names a registered, moved file, so a request can never reach anything else in the directory', async () => {
    const { path, parquetDir, remove } = setup();
    await moveDays({ dbPath: path, dir: parquetDir, now: due });
    const reader = openReader(path, { parquetDir });
    expect(reader.parquetPath(`${DAY}.000.parquet`)).toBe(join(parquetDir, `${DAY}.000.parquet`));
    for (const name of ['../archive.sqlite', `${DAY}.000.parquet.tmp`, '', `/${DAY}.000.parquet`]) {
      expect(reader.parquetPath(name)).toBeNull();
    }
    reader.close();
    // Without a directory, or before anything moved, the reader serves no files and reads SQLite only.
    const plain = openReader(path);
    expect(plain.parquetFiles()).toEqual([]);
    expect(await plain.records(eth, 0, 2_000_000_000)).toEqual([]);
    plain.close();
    remove();
  });
});

describe('backupArchive with Parquet files', () => {
  test('copies each registered file once, checked against its hash, and needs the directory to find them', async () => {
    const { path, parquetDir, remove } = setup();
    await moveDays({ dbPath: path, dir: parquetDir, now: due });
    const target = mkdtempSync(join(tmpdir(), 'signed-archive-backup-'));
    dirs.push(target);

    const first = await backupArchive(path, target, { parquetDir, now: new Date('2026-11-06T01:00:00Z') });
    expect(first.parquetCopied).toBe(1);
    expect(existsSync(join(target, 'parquet', `${DAY}.000.parquet`))).toBe(true);
    // The copy reads like the original: its SQLite and its parquet/ directory together.
    expect(await answers(first.path, join(target, 'parquet'))).toEqual(await answers(path, parquetDir));

    const second = await backupArchive(path, target, { parquetDir, now: new Date('2026-11-06T02:00:00Z') });
    expect(second.parquetCopied).toBe(0);
    await expect(backupArchive(path, target, { now: new Date('2026-11-06T03:00:00Z') })).rejects.toThrow('parquet');

    // A source file that changed on disk is caught, and the bad copy is not left behind.
    const elsewhere = mkdtempSync(join(tmpdir(), 'signed-archive-backup-'));
    dirs.push(elsewhere);
    copyFileSync(join(parquetDir, `${DAY}.000.parquet`), join(parquetDir, 'original.parquet'));
    await Bun.write(join(parquetDir, `${DAY}.000.parquet`), 'not the registered file');
    await expect(backupArchive(path, elsewhere, { parquetDir })).rejects.toThrow('SHA-256');
    expect(existsSync(join(elsewhere, 'parquet', `${DAY}.000.parquet`))).toBe(false);
    remove();
  });
});
