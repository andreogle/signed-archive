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

// Asking peers for records this archive missed, one row per window of a gap and peer. A gap is split into windows
// once, when it is first found; each window is then asked about independently, so a slow or failing window never
// holds back the others. `from` and `to` are unix seconds (as signed), inclusive, at most 900 apart. Status: `pending`
// (not asked yet, a retry due, or a second ask due), `done`, `skipped` (another peer already covered it, or the
// airnode is no longer configured) or `failed` (gave up). `attempts` counts failures; `retry_at` is unix ms;
// `rechecked` is whether the one second ask, for a peer that had missed part of the window too, has been scheduled;
// `records` counts new records it added. These rows are bookkeeping, not signed data, so they are updated in place.
const REPAIR_WINDOWS = `
  CREATE TABLE IF NOT EXISTS repair_windows (
    airnode   BLOB    NOT NULL,
    endpoint  TEXT    NOT NULL,
    "from"    INTEGER NOT NULL,
    "to"      INTEGER NOT NULL,
    peer      TEXT    NOT NULL,
    status    TEXT    NOT NULL,
    attempts  INTEGER NOT NULL,
    retry_at  INTEGER NOT NULL,
    rechecked INTEGER NOT NULL,
    records   INTEGER NOT NULL,
    PRIMARY KEY (airnode, endpoint, "from", peer)
  ) WITHOUT ROWID
`;

// Stretches (unix seconds, as signed) that peers' records actually cover, so the explorer stops shading only what was
// filled. Overlapping or nearly touching stretches for one airnode and endpoint are merged into one row, so stretches
// from consecutive windows join up. `peer` is the peer whose answer last extended the stretch.
const PEER_COVERAGE = `
  CREATE TABLE IF NOT EXISTS peer_coverage (
    airnode   BLOB    NOT NULL,
    endpoint  TEXT    NOT NULL,
    "from"    INTEGER NOT NULL,
    "to"      INTEGER NOT NULL,
    peer      TEXT    NOT NULL,
    PRIMARY KEY (airnode, endpoint, "from", peer)
  ) WITHOUT ROWID
`;

// Stretches with no successful request for an airnode and endpoint (from either source) longer than `threshold`,
// that have since closed, in unix milliseconds. A gap still open has nothing to ask about yet. Only gaps that end
// after `since` are listed, but a gap may start before it: the first poll after `since` looks back for its
// predecessor, so an outage longer than the lookback is still found whole.
const CLOSED_GAPS = `
  SELECT hex(airnode) AS airnode, endpoint, previous AS "from", fetched_at AS "to" FROM (
    SELECT airnode, endpoint, fetched_at,
           CASE WHEN lag(fetched_at) OVER w IS NULL THEN (
             SELECT max(p.fetched_at) FROM polls p
             WHERE p.airnode = recent.airnode AND p.endpoint = recent.endpoint AND p.status = 200
               AND p.fetched_at < $since
           ) ELSE lag(fetched_at) OVER w END AS previous
    FROM polls recent WHERE status = 200 AND fetched_at >= $since
    WINDOW w AS (PARTITION BY airnode, endpoint ORDER BY fetched_at)
  ) WHERE previous IS NOT NULL AND fetched_at - previous > $threshold
  ORDER BY "from"`;

export type WindowStatus = 'pending' | 'done' | 'skipped' | 'failed';
export interface RepairWindow {
  airnode: Address;
  endpoint: Endpoint;
  from: number;
  to: number;
  peer: string;
  status: WindowStatus;
  attempts: number;
  retryAt: number;
  rechecked: boolean;
  records: number;
}

export interface Coverage {
  airnode: Address;
  endpoint: Endpoint;
  from: number;
  to: number;
  peer: string;
}

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
  db.run(REPAIR_WINDOWS);
  db.run('CREATE INDEX IF NOT EXISTS repair_windows_due ON repair_windows (status, retry_at)');
  db.run(PEER_COVERAGE);
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

  const gapsQuery = db.prepare<
    { airnode: string; endpoint: Endpoint; from: number; to: number },
    { since: number; threshold: number }
  >(CLOSED_GAPS);
  const closedGaps = (since: number, threshold: number) => {
    return gapsQuery
      .all({ since, threshold })
      .map((gap) => ({ ...gap, airnode: `0x${gap.airnode.toLowerCase()}` as Address }));
  };

  // Windows are inserted once; finding the same gap again changes nothing.
  const windowInsert = db.prepare(
    `INSERT OR IGNORE INTO repair_windows (airnode, endpoint, "from", "to", peer, status, attempts, retry_at, rechecked, records)
     VALUES ($airnode, $endpoint, $from, $to, $peer, 'pending', 0, 0, 0, 0)`
  );
  const addWindows = db.transaction(
    (rows: readonly Pick<RepairWindow, 'airnode' | 'endpoint' | 'from' | 'to' | 'peer'>[]) => {
      let added = 0;
      for (const row of rows) added += windowInsert.run({ ...row, airnode: hexToBytes(row.airnode) }).changes;
      return added;
    }
  );

  type WindowRow = Omit<RepairWindow, 'airnode' | 'rechecked'> & { airnode: string; rechecked: number };
  const toWindow = ({ airnode, rechecked, ...row }: WindowRow): RepairWindow => {
    return { ...row, airnode: `0x${airnode.toLowerCase()}` as Address, rechecked: rechecked === 1 };
  };
  const windowColumns = `hex(airnode) AS airnode, endpoint, "from", "to", peer, status, attempts, retry_at AS retryAt,
    rechecked, records`;
  // Newest first: recent stretches are what people look at, and every window is reached in time either way.
  const dueQuery = db.prepare<WindowRow, { now: number; limit: number }>(
    `SELECT ${windowColumns} FROM repair_windows WHERE status = 'pending' AND retry_at <= $now
     ORDER BY "from" DESC LIMIT $limit`
  );
  const dueWindows = (now: number, limit: number) => dueQuery.all({ now, limit }).map(toWindow);
  const windowQuery = db.prepare<WindowRow, { airnode: Uint8Array; endpoint: string; from: number; peer: string }>(
    `SELECT ${windowColumns} FROM repair_windows
     WHERE airnode = $airnode AND endpoint = $endpoint AND "from" = $from AND peer = $peer`
  );
  const getWindow = ({
    airnode,
    endpoint,
    from,
    peer,
  }: Pick<RepairWindow, 'airnode' | 'endpoint' | 'from' | 'peer'>) => {
    const row = windowQuery.get({ airnode: hexToBytes(airnode), endpoint, from, peer });
    return row ? toWindow(row) : null;
  };
  const windowUpdate = db.prepare(
    `UPDATE repair_windows SET status = $status, attempts = $attempts, retry_at = $retryAt, rechecked = $rechecked,
       records = $records
     WHERE airnode = $airnode AND endpoint = $endpoint AND "from" = $from AND peer = $peer`
  );
  const putWindow = (window: RepairWindow) => {
    windowUpdate.run({
      airnode: hexToBytes(window.airnode),
      endpoint: window.endpoint,
      from: window.from,
      peer: window.peer,
      status: window.status,
      attempts: window.attempts,
      retryAt: window.retryAt,
      rechecked: window.rechecked ? 1 : 0,
      records: window.records,
    });
  };
  const windowCounts = () => {
    return Object.fromEntries(
      db
        .query<{ status: WindowStatus; n: number }, []>(
          'SELECT status, count(*) AS n FROM repair_windows GROUP BY status'
        )
        .all()
        .map(({ status, n }) => [status, n])
    ) as Partial<Record<WindowStatus, number>>;
  };

  // Adds stretches, merging each with any stored stretch of the same airnode and endpoint that overlaps it or comes
  // within `joinWithin` seconds, so stretches from consecutive windows become one.
  const touching = db.prepare<
    { from: number; to: number },
    { airnode: Uint8Array; endpoint: string; from: number; to: number }
  >(
    `SELECT "from", "to" FROM peer_coverage
     WHERE airnode = $airnode AND endpoint = $endpoint AND "from" <= $to AND "to" >= $from`
  );
  const removeStretch = db.prepare(
    `DELETE FROM peer_coverage WHERE airnode = $airnode AND endpoint = $endpoint AND "from" = $from`
  );
  const insertStretch = db.prepare(
    `INSERT OR REPLACE INTO peer_coverage (airnode, endpoint, "from", "to", peer) VALUES ($airnode, $endpoint, $from, $to, $peer)`
  );
  const addCoverage = db.transaction((rows: readonly Coverage[], joinWithin: number) => {
    for (const row of rows) {
      const airnode = hexToBytes(row.airnode);
      const key = { airnode, endpoint: row.endpoint };
      const neighbours = touching.all({ ...key, from: row.from - joinWithin, to: row.to + joinWithin });
      const from = Math.min(row.from, ...neighbours.map((stretch) => stretch.from));
      const to = Math.max(row.to, ...neighbours.map((stretch) => stretch.to));
      for (const stretch of neighbours) removeStretch.run({ ...key, from: stretch.from });
      insertStretch.run({ ...key, from, to, peer: row.peer });
    }
  });
  // Whether stored stretches for the airnode and endpoint already span [from, to], give or take `slack` seconds.
  const coveredQuery = db.prepare<{ found: 1 }, { airnode: Uint8Array; endpoint: string; from: number; to: number }>(
    `SELECT 1 AS found FROM peer_coverage
     WHERE airnode = $airnode AND endpoint = $endpoint AND "from" <= $from AND "to" >= $to LIMIT 1`
  );
  const isCovered = (airnode: Address, endpoint: Endpoint, from: number, to: number, slack: number) => {
    return coveredQuery.get({ airnode: hexToBytes(airnode), endpoint, from: from + slack, to: to - slack }) !== null;
  };

  return {
    save,
    add,
    has,
    closedGaps,
    addWindows,
    dueWindows,
    getWindow,
    putWindow,
    windowCounts,
    addCoverage,
    isCovered,
    close: () => db.close(),
  };
}
