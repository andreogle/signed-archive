import { Database } from 'bun:sqlite';
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeArchive } from '../src/merge.ts';
import { openStore } from '../src/store.ts';
import { coingecko } from './fixtures.ts';

const dir = mkdtempSync(join(tmpdir(), 'signed-archive-sources-'));
const airnode = `x'${coingecko.airnode.slice(2)}'`;

// The polls table as archives wrote it before providers' own Signed APIs were read: no source column.
function legacyArchive(name: string) {
  const path = join(dir, name);
  const db = new Database(path, { create: true });
  db.run(`CREATE TABLE datapoints (airnode BLOB NOT NULL, template_id BLOB NOT NULL, timestamp INTEGER NOT NULL,
    value BLOB NOT NULL, signature BLOB NOT NULL, endpoint TEXT NOT NULL, fetched_at INTEGER NOT NULL,
    PRIMARY KEY (airnode, template_id, timestamp, value)) WITHOUT ROWID`);
  db.run(`CREATE TABLE polls (airnode BLOB NOT NULL, endpoint TEXT NOT NULL, fetched_at INTEGER NOT NULL,
    status INTEGER, received INTEGER NOT NULL, rejected INTEGER NOT NULL, saved INTEGER NOT NULL,
    PRIMARY KEY (airnode, endpoint, fetched_at)) WITHOUT ROWID`);
  db.run(`INSERT INTO polls VALUES (${airnode}, 'public', 1000, 200, 0, 0, 0)`);
  db.close();
  return path;
}

const sources = (path: string) => {
  const db = new Database(path, { readonly: true });
  const rows = db.query<{ source: string }, []>('SELECT source FROM polls ORDER BY fetched_at').all();
  db.close();
  return rows.map(({ source }) => source);
};

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('opening a legacy archive adds the source column, and its existing polls read as API3', () => {
  const path = legacyArchive('legacy.sqlite');
  const store = openStore(path);
  store.save([], {
    airnode: coingecko.airnode,
    endpoint: 'public',
    source: 'provider',
    fetchedAt: 2000,
    status: 200,
    received: 0,
    rejected: 0,
  });
  store.close();
  expect(sources(path)).toEqual(['api3', 'provider']);
});

test('merging a legacy archive keeps its polls as API3, and polls from an unknown source are rejected', async () => {
  const legacy = legacyArchive('legacy-source.sqlite');
  const target = join(dir, 'target.sqlite');
  expect(await mergeArchive({ sourcePath: legacy, dbPath: target })).toMatchObject({ polls: 1, rejectedPolls: 0 });
  expect(sources(target)).toEqual(['api3']);

  const current = join(dir, 'current.sqlite');
  openStore(current).close();
  const db = new Database(current);
  db.run(`INSERT INTO polls VALUES (${airnode}, 'public', 3000, 200, 0, 0, 0, 'somewhere-else')`);
  db.close();
  expect(await mergeArchive({ sourcePath: current, dbPath: target })).toMatchObject({ polls: 0, rejectedPolls: 1 });
});
