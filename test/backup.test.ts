import { Database } from 'bun:sqlite';
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasValidSignature } from '../src/signed-data.ts';
import { backupArchive } from '../src/store.ts';
import { coingecko, fixtureDb } from './fixtures.ts';

const source = fixtureDb();
const dir = mkdtempSync(join(tmpdir(), 'signed-archive-backup-'));

afterAll(() => {
  source.remove();
  rmSync(dir, { recursive: true, force: true });
});

test('writes a timestamped copy with every record and poll, still verifiable', async () => {
  const path = backupArchive(source.path, join(dir, 'nested'), new Date('2026-10-28T12:34:56.789Z'));
  expect(path).toBe(join(dir, 'nested', 'archive-2026-10-28T12-34-56-789Z.sqlite'));

  const count = (file: string, table: string) => {
    const db = new Database(file, { readonly: true });
    const { n } = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get() ?? { n: -1 };
    db.close();
    return n;
  };
  for (const table of ['datapoints', 'polls']) expect(count(path, table)).toBe(count(source.path, table));

  const copy = new Database(path, { readonly: true });
  const row = copy
    .query<{ value: string; signature: string }, []>(
      `SELECT hex(value) AS value, hex(signature) AS signature FROM datapoints WHERE timestamp = ${coingecko.timestamp}`
    )
    .get();
  copy.close();
  const restored = {
    ...coingecko,
    encodedValue: `0x${row?.value.toLowerCase()}`,
    signature: `0x${row?.signature.toLowerCase()}`,
  };
  expect(await hasValidSignature(restored as typeof coingecko)).toBe(true);
});

test('refuses to overwrite an existing backup', () => {
  const at = new Date('2026-10-28T00:00:00.000Z');
  backupArchive(source.path, dir, at);
  expect(() => backupArchive(source.path, dir, at)).toThrow();
});
