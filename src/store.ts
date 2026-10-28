import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Address, hexToBytes } from 'viem';
import type { Endpoint, Source } from './config.ts';
import type { SignedDatum } from './signed-data.ts';

// Hex fields are stored as bytes (about half the size); read them back with SQL `hex()`.
// The key includes the value, so two different values signed for the same feed and timestamp
// both land as separate rows. That pair is the equivocation evidence the archive exists to catch.
const DATAPOINTS = `
  CREATE TABLE IF NOT EXISTS datapoints (
    airnode     BLOB    NOT NULL,
    template_id BLOB    NOT NULL,
    timestamp   INTEGER NOT NULL,
    value       BLOB    NOT NULL,
    signature   BLOB    NOT NULL,
    endpoint    TEXT    NOT NULL,
    fetched_at  INTEGER NOT NULL,
    PRIMARY KEY (airnode, template_id, timestamp, value)
  ) WITHOUT ROWID
`;

// One row per request, failed or not, so the archive knows when it was watching. A stretch with no
// polls means the archiver was down; polls with a failed status mean the provider was. `fetched_at`
// matches the datapoints that request saved. `status` is the HTTP status, or NULL when the request
// failed without a usable response (network error, timeout, unreadable body). `source` is which Signed API answered;
// archives from before providers' own APIs were read only polled API3's, so that is the default.
const POLLS = `
  CREATE TABLE IF NOT EXISTS polls (
    airnode    BLOB    NOT NULL,
    endpoint   TEXT    NOT NULL,
    fetched_at INTEGER NOT NULL,
    status     INTEGER,
    received   INTEGER NOT NULL,
    rejected   INTEGER NOT NULL,
    saved      INTEGER NOT NULL,
    source     TEXT    NOT NULL DEFAULT 'api3',
    PRIMARY KEY (airnode, endpoint, fetched_at)
  ) WITHOUT ROWID
`;

// Archives written before a table was added don't have it, and a read-only connection can't create it.
export const hasTable = (db: Database, name: string) => {
  return (
    db
      .query<{ found: 1 }, { name: string }>(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = $name"
      )
      .get({ name }) !== null
  );
};

// Whether a table has a column; archives written before a column was added lack it.
export const hasColumn = (db: Database, table: string, column: string) => {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some(({ name }) => name === column);
};

export interface Poll {
  airnode: Address;
  endpoint: Endpoint;
  source: Source;
  // Unix milliseconds, set by us.
  fetchedAt: number;
  status: number | null;
  received: number;
  rejected: number;
}

export interface StoredPoll extends Poll {
  saved: number;
}

export interface StoredRecord {
  datum: SignedDatum;
  endpoint: Endpoint;
  fetchedAt: number;
}

// Writes a consistent copy of the archive into `dir` and returns its path. In WAL mode a plain file copy of a live
// archive can miss committed data, so this uses VACUUM INTO, which also runs while the archiver keeps writing.
export function backupArchive(dbPath: string, dir: string, now = new Date()) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `archive-${now.toISOString().replace(/[:.]/g, '-')}.sqlite`);
  const db = new Database(dbPath, { readonly: true, strict: true });
  try {
    db.run('VACUUM INTO ?', [path]);
  } finally {
    db.close();
  }
  return path;
}

export function openStore(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run('PRAGMA journal_mode = WAL');
  // `merge` can write while the archiver does; wait for the other writer instead of failing.
  db.run('PRAGMA busy_timeout = 10000');
  db.run(DATAPOINTS);
  db.run(POLLS);
  // A new column only: existing polls keep their rows and read as API3's.
  if (!hasColumn(db, 'polls', 'source')) db.run("ALTER TABLE polls ADD COLUMN source TEXT NOT NULL DEFAULT 'api3'");
  db.run('CREATE INDEX IF NOT EXISTS polls_by_time ON polls (fetched_at)');

  const insert = db.prepare(
    `INSERT OR IGNORE INTO datapoints (airnode, template_id, timestamp, value, signature, endpoint, fetched_at)
     VALUES ($airnode, $templateId, $timestamp, $value, $signature, $endpoint, $fetchedAt)`
  );
  const exists = db.prepare<
    { found: 1 },
    { airnode: Uint8Array; templateId: Uint8Array; timestamp: number; value: Uint8Array }
  >(
    `SELECT 1 AS found FROM datapoints
     WHERE airnode = $airnode AND template_id = $templateId AND timestamp = $timestamp AND value = $value`
  );
  const insertPoll = db.prepare(
    `INSERT OR IGNORE INTO polls (airnode, endpoint, fetched_at, status, received, rejected, saved, source)
     VALUES ($airnode, $endpoint, $fetchedAt, $status, $received, $rejected, $saved, $source)`
  );

  // Inserts one verified record; returns 1 if it was new, 0 if the archive already had it.
  const insertRecord = ({ datum, endpoint, fetchedAt }: StoredRecord) => {
    return insert.run({
      airnode: hexToBytes(datum.airnode),
      templateId: hexToBytes(datum.templateId),
      timestamp: Number(datum.timestamp),
      value: hexToBytes(datum.encodedValue),
      signature: hexToBytes(datum.signature),
      endpoint,
      fetchedAt,
    }).changes;
  };
  const insertPollRow = (poll: StoredPoll) => insertPoll.run({ ...poll, airnode: hexToBytes(poll.airnode) });

  // Stores the verified records from one request together with its poll row, in one transaction.
  const save = db.transaction((data: readonly SignedDatum[], poll: Poll) => {
    let saved = 0;
    for (const datum of data) saved += insertRecord({ datum, endpoint: poll.endpoint, fetchedAt: poll.fetchedAt });
    insertPollRow({ ...poll, saved });
    return saved;
  });

  // Adds records and polls copied from another archive, each record keeping when that archive fetched it.
  // Callers verify everything first; existing rows are never replaced.
  const add = db.transaction((records: readonly StoredRecord[], polls: readonly StoredPoll[]) => {
    let added = 0;
    for (const record of records) added += insertRecord(record);
    for (const poll of polls) insertPollRow(poll);
    return added;
  });

  // Whether this exact record (same feed, time and value) is already stored.
  const has = (datum: SignedDatum) => {
    const key = {
      airnode: hexToBytes(datum.airnode),
      templateId: hexToBytes(datum.templateId),
      timestamp: Number(datum.timestamp),
      value: hexToBytes(datum.encodedValue),
    };
    return exists.get(key) !== null;
  };

  return { save, add, has, close: () => db.close() };
}
