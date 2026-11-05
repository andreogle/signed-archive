import { Database } from 'bun:sqlite';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep, setImmediate as yieldToLoop } from 'node:timers/promises';
import { type AsyncBuffer, type FileMetaData, parquetMetadataAsync, parquetRead } from 'hyparquet';
import { fileWriter, ParquetWriter } from 'hyparquet-writer';
import { log } from './logger.ts';
import { go } from './result.ts';
import { hasTable } from './store.ts';

// Closed days of records leave SQLite for Parquet files, one or more per UTC day of signed timestamps. A day moves
// once it ended more than `afterDays` ago. Nothing leaves SQLite until its file has been written, flushed to disk,
// read back and matched row for row (SHA-256 over every field), renamed into place and registered with its hash.
// Files are never changed afterwards: records that arrive later for a moved day (peer repair, a merge, a stale feed
// served again) go to SQLite as usual, and the next move writes the new ones to another part file of that day and
// drops the ones a file already holds.
//
// The registry lives in SQLite: `parquet_files` (one row per file, with its hash) and `parquet_keys` (for each
// file, the half-open row range and timestamp span of each airnode and template). Rows in a file are sorted by
// airnode, template, timestamp and value, so each key's rows are one contiguous range the reader can fetch alone.

export const PARQUET_FILES = `
  CREATE TABLE IF NOT EXISTS parquet_files (
    name       TEXT    PRIMARY KEY,
    day        TEXT    NOT NULL,
    rows       INTEGER NOT NULL,
    bytes      INTEGER NOT NULL,
    sha256     TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    moved      INTEGER NOT NULL
  )
`;
export const PARQUET_KEYS = `
  CREATE TABLE IF NOT EXISTS parquet_keys (
    airnode         BLOB    NOT NULL,
    template_id     BLOB    NOT NULL,
    name            TEXT    NOT NULL,
    first_timestamp INTEGER NOT NULL,
    last_timestamp  INTEGER NOT NULL,
    row_start       INTEGER NOT NULL,
    row_end         INTEGER NOT NULL,
    PRIMARY KEY (airnode, template_id, name)
  ) WITHOUT ROWID
`;

export const DEFAULT_AFTER_DAYS = 7;
// About 75 MB per file and a few hundred MB of memory while writing one; a busy day has several parts.
const MAX_ROWS_PER_FILE = 1_000_000;
// Small row groups keep the page index fine-grained, so reading one key's rows touches little of the file.
const ROW_GROUP_ROWS = 8192;
// Rows deleted per transaction, so the archiver never waits long for the write lock.
const DELETE_BATCH = 5000;
const DAY_SECONDS = 86_400;

// Hex-free and exact: the signed fields as bytes, as SQLite stores them. `source` is which Signed API served the
// record, from the poll that saved it, or null for records merged or repaired from another archive.
const SCHEMA = [
  { name: 'root', num_children: 8 },
  { name: 'airnode', type: 'FIXED_LEN_BYTE_ARRAY', type_length: 20, repetition_type: 'REQUIRED' },
  { name: 'template_id', type: 'FIXED_LEN_BYTE_ARRAY', type_length: 32, repetition_type: 'REQUIRED' },
  { name: 'timestamp', type: 'INT64', repetition_type: 'REQUIRED' },
  { name: 'value', type: 'FIXED_LEN_BYTE_ARRAY', type_length: 32, repetition_type: 'REQUIRED' },
  { name: 'signature', type: 'FIXED_LEN_BYTE_ARRAY', type_length: 65, repetition_type: 'REQUIRED' },
  { name: 'endpoint', type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'REQUIRED' },
  { name: 'fetched_at', type: 'INT64', repetition_type: 'REQUIRED' },
  { name: 'source', type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'OPTIONAL' },
] as const;
export type Column = (typeof SCHEMA)[number]['name'];

export interface StoredRow {
  airnode: Uint8Array;
  templateId: Uint8Array;
  timestamp: number;
  value: Uint8Array;
  signature: Uint8Array;
  endpoint: string;
  fetchedAt: number;
  source: string | null;
}

export const dayOf = (timestamp: number) => new Date(timestamp * 1000).toISOString().slice(0, 10);
const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;
const bytesEqual = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;
const toBytes = (value: unknown) => (value instanceof Uint8Array ? value : new Uint8Array(0));

// Every field of every row, in order, so two files hash alike only if they hold exactly the same rows.
function hashRow(hash: Bun.CryptoHasher, row: StoredRow) {
  const numbers = new DataView(new ArrayBuffer(16));
  numbers.setBigInt64(0, BigInt(row.timestamp));
  numbers.setBigInt64(8, BigInt(row.fetchedAt));
  hash.update(row.airnode).update(row.templateId).update(row.value).update(row.signature);
  hash.update(new Uint8Array(numbers.buffer));
  hash.update(`${row.endpoint}\u0000${row.source ?? '\u0001'}\u0000`);
}

// A local file as hyparquet's AsyncBuffer, reading only the byte ranges asked for.
function fileBuffer(path: string): AsyncBuffer {
  const file = Bun.file(path);
  return { byteLength: file.size, slice: (start, end) => file.slice(start, end).arrayBuffer() };
}

const toRow = (raw: Record<string, unknown>): StoredRow => {
  return {
    airnode: toBytes(raw.airnode),
    templateId: toBytes(raw.template_id),
    timestamp: Number(raw.timestamp),
    value: toBytes(raw.value),
    signature: toBytes(raw.signature),
    endpoint: String(raw.endpoint ?? ''),
    fetchedAt: Number(raw.fetched_at),
    source: typeof raw.source === 'string' ? raw.source : null,
  };
};

async function readRows(
  file: AsyncBuffer,
  metadata: FileMetaData,
  rowStart: number,
  rowEnd: number,
  columns?: readonly Column[]
): Promise<StoredRow[]> {
  let rows: StoredRow[] = [];
  await parquetRead({
    file,
    metadata,
    rowStart,
    rowEnd,
    ...(columns ? { columns: [...columns] } : {}),
    utf8: false,
    useOffsetIndex: true,
    rowFormat: 'object',
    onComplete: (data) => {
      rows = data.map(toRow);
    },
  });
  return rows;
}

// SHA-256 over every row of a file, read back one row group at a time.
export async function hashFileRows(path: string) {
  const file = fileBuffer(path);
  const metadata = await parquetMetadataAsync(file);
  const hash = new Bun.CryptoHasher('sha256');
  let start = 0;
  for (const group of metadata.row_groups) {
    const end = start + Number(group.num_rows);
    for (const row of await readRows(file, metadata, start, end)) hashRow(hash, row);
    start = end;
  }
  return { rows: start, sha256: hash.digest('hex') };
}

interface KeyRange {
  airnode: Uint8Array;
  templateId: Uint8Array;
  first: number;
  last: number;
  rowStart: number;
  rowEnd: number;
}

// One part file being written: rows are buffered into row groups and hashed as they go.
function startPart(dir: string, name: string) {
  const final = join(dir, name);
  const temporary = `${final}.tmp`;
  const writer = new ParquetWriter({ writer: fileWriter(temporary), schema: [...SCHEMA] as never });
  const hash = new Bun.CryptoHasher('sha256');
  const keys: KeyRange[] = [];
  let pending: StoredRow[] = [];
  let rows = 0;

  const flush = async () => {
    if (pending.length === 0) return;
    const column = <T>(pick: (row: StoredRow) => T) => pending.map(pick);
    await writer.write({
      columnData: [
        { name: 'airnode', data: column((row) => row.airnode) },
        { name: 'template_id', data: column((row) => row.templateId) },
        { name: 'timestamp', data: BigInt64Array.from(column((row) => BigInt(row.timestamp))) },
        { name: 'value', data: column((row) => row.value) },
        { name: 'signature', data: column((row) => row.signature) },
        { name: 'endpoint', data: column((row) => row.endpoint) },
        { name: 'fetched_at', data: BigInt64Array.from(column((row) => BigInt(row.fetchedAt))) },
        { name: 'source', data: column((row) => row.source) },
      ],
      rowGroupSize: ROW_GROUP_ROWS,
      pageSize: 32768,
    } as never);
    pending = [];
  };

  const add = async (row: StoredRow) => {
    const last = keys.at(-1);
    if (last && bytesEqual(last.airnode, row.airnode) && bytesEqual(last.templateId, row.templateId)) {
      last.last = row.timestamp;
      last.rowEnd = rows + 1;
    } else {
      keys.push({
        airnode: row.airnode,
        templateId: row.templateId,
        first: row.timestamp,
        last: row.timestamp,
        rowStart: rows,
        rowEnd: rows + 1,
      });
    }
    hashRow(hash, row);
    pending.push(row);
    rows += 1;
    if (pending.length >= ROW_GROUP_ROWS) await flush();
  };

  // Finishes the file, flushes it to disk and checks it reads back exactly as written. Only then is it renamed into
  // place, so a file under its final name is always complete and checked.
  const finish = async () => {
    await flush();
    await writer.finish();
    const fd = openSync(temporary, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const expected = hash.digest('hex');
    const back = await hashFileRows(temporary);
    if (back.rows !== rows || back.sha256 !== expected) {
      rmSync(temporary, { force: true });
      throw new Error(`${name} did not read back as written`);
    }
    renameSync(temporary, final);
    const sha256 = new Bun.CryptoHasher('sha256').update(await Bun.file(final).arrayBuffer()).digest('hex');
    return { name, rows, bytes: Bun.file(final).size, sha256, keys };
  };

  const abandon = () => rmSync(temporary, { force: true });
  return { add, finish, abandon, rows: () => rows };
}

type Part = Awaited<ReturnType<ReturnType<typeof startPart>['finish']>>;

export interface MoveOptions {
  dbPath: string;
  dir: string;
  afterDays?: number;
  // Unix milliseconds; tests pass a fixed clock.
  now?: number;
  signal?: AbortSignal;
  maxRowsPerFile?: number;
}

// Moves every due day from SQLite to Parquet, oldest first. Returns what it wrote and deleted.
export async function moveDays({
  dbPath,
  dir,
  afterDays = DEFAULT_AFTER_DAYS,
  now = Date.now(),
  signal,
  maxRowsPerFile = MAX_ROWS_PER_FILE,
}: MoveOptions) {
  mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath, { strict: true });
  db.run('PRAGMA busy_timeout = 10000');
  db.run(PARQUET_FILES);
  db.run(PARQUET_KEYS);
  const totals = { files: [] as string[], written: 0, deleted: 0 };
  try {
    // A file registered but not yet cleared from SQLite: the process stopped while deleting. Finish that first.
    for (const { name } of db.query<{ name: string }, []>('SELECT name FROM parquet_files WHERE moved = 0').all()) {
      totals.deleted += await clearMoved(db, dir, name, signal);
    }
    const cutoff = Math.floor(now / 1000) - afterDays * DAY_SECONDS;
    for (;;) {
      if (signal?.aborted) break;
      const oldest = oldestTimestamp(db);
      if (oldest === null) break;
      const day = dayOf(oldest);
      if (dayStart(day) + DAY_SECONDS > cutoff) break;
      const result = await moveDay(db, dir, day, maxRowsPerFile, signal);
      totals.files.push(...result.files);
      totals.written += result.written;
      totals.deleted += result.deleted;
      if (result.written === 0 && result.deleted === 0) break;
    }
  } finally {
    db.close();
  }
  return totals;
}

// Each airnode and template in `datapoints`, in key order: one indexed lookup per key, not a scan of the table.
function* keysOf(db: Database) {
  const first = db.query<{ airnode: Uint8Array; templateId: Uint8Array }, []>(
    'SELECT airnode, template_id AS templateId FROM datapoints ORDER BY airnode, template_id LIMIT 1'
  );
  const next = db.query<
    { airnode: Uint8Array; templateId: Uint8Array },
    { airnode: Uint8Array; templateId: Uint8Array }
  >(
    `SELECT airnode, template_id AS templateId FROM datapoints WHERE (airnode, template_id) > ($airnode, $templateId)
     ORDER BY airnode, template_id LIMIT 1`
  );
  let key = first.get();
  while (key) {
    yield key;
    key = next.get(key);
  }
}

function oldestTimestamp(db: Database) {
  const min = db.query<{ t: number | null }, { airnode: Uint8Array; templateId: Uint8Array }>(
    'SELECT min(timestamp) AS t FROM datapoints WHERE airnode = $airnode AND template_id = $templateId'
  );
  let oldest: number | null = null;
  for (const key of keysOf(db)) {
    const t = min.get(key)?.t ?? null;
    if (t !== null && (oldest === null || t < oldest)) oldest = t;
  }
  return oldest;
}

async function moveDay(db: Database, dir: string, day: string, maxRowsPerFile: number, signal?: AbortSignal) {
  const from = dayStart(day);
  const to = from + DAY_SECONDS - 1;
  const rowsOfKey = db.query<
    Omit<StoredRow, 'templateId' | 'fetchedAt'> & { templateId: Uint8Array; fetchedAt: number },
    { airnode: Uint8Array; templateId: Uint8Array; from: number; to: number }
  >(
    `SELECT d.airnode, d.template_id AS templateId, d.timestamp, d.value, d.signature, d.endpoint,
            d.fetched_at AS fetchedAt, p.source
     FROM datapoints d
     LEFT JOIN polls p ON p.airnode = d.airnode AND p.endpoint = d.endpoint AND p.fetched_at = d.fetched_at
     WHERE d.airnode = $airnode AND d.template_id = $templateId AND d.timestamp BETWEEN $from AND $to
     ORDER BY d.timestamp, d.value`
  );
  const priorFiles = db
    .query<{ name: string }, { day: string }>('SELECT name FROM parquet_files WHERE day = $day ORDER BY name')
    .all({ day })
    .map(({ name }) => name);
  const files = new Map<string, { file: AsyncBuffer; metadata: FileMetaData }>();
  // Records of this key the day's earlier files already hold, by timestamp and value: those are only deleted.
  const alreadyFiled = async (key: { airnode: Uint8Array; templateId: Uint8Array }) => {
    const held = new Set<string>();
    for (const name of priorFiles) {
      const range = db
        .query<{ rowStart: number; rowEnd: number }, { airnode: Uint8Array; templateId: Uint8Array; name: string }>(
          `SELECT row_start AS rowStart, row_end AS rowEnd FROM parquet_keys
           WHERE airnode = $airnode AND template_id = $templateId AND name = $name`
        )
        .get({ ...key, name });
      if (!range) continue;
      const opened = files.get(name) ?? (await openFile(join(dir, name)));
      files.set(name, opened);
      const rows = await readRows(opened.file, opened.metadata, range.rowStart, range.rowEnd, ['timestamp', 'value']);
      for (const row of rows) held.add(`${row.timestamp}:${Buffer.from(row.value).toString('hex')}`);
    }
    return held;
  };

  let partNumber = priorFiles.length;
  const nameOf = (part: number) => `${day}.${String(part).padStart(3, '0')}.parquet`;
  // Asserted, not annotated: the part is assigned inside a closure, so narrowing it to null would be wrong.
  let part = null as ReturnType<typeof startPart> | null;
  const parts: Part[] = [];
  const duplicates: StoredRow[] = [];
  const [error] = await go(async () => {
    for (const key of [...keysOf(db)]) {
      if (signal?.aborted) break;
      const rows = rowsOfKey.all({ ...key, from, to });
      if (rows.length === 0) continue;
      const held = priorFiles.length > 0 ? await alreadyFiled(key) : new Set<string>();
      for (const row of rows) {
        if (held.has(`${row.timestamp}:${Buffer.from(row.value).toString('hex')}`)) {
          duplicates.push(row);
          continue;
        }
        if (part && part.rows() >= maxRowsPerFile) {
          parts.push(await part.finish());
          part = null;
        }
        part ??= startPart(dir, nameOf(partNumber++));
        await part.add(row);
      }
      // Let polling run between keys: this loop is otherwise synchronous for most of a day's records.
      await yieldToLoop();
    }
    if (signal?.aborted) {
      part?.abandon();
      part = null;
    }
    if (part) parts.push(await part.finish());
    part = null;
  });
  if (error) {
    part?.abandon();
    throw error;
  }

  register(db, day, parts);
  let deleted = 0;
  for (const written of parts) {
    log.info('parquet file written', { day, file: written.name, rows: written.rows, bytes: written.bytes });
    deleted += await clearMoved(db, dir, written.name, signal);
  }
  deleted += deleteRows(db, duplicates);
  if (duplicates.length > 0) log.info('filed duplicates dropped', { day, deleted: duplicates.length });
  return { files: parts.map(({ name }) => name), written: parts.reduce((sum, { rows }) => sum + rows, 0), deleted };
}

function register(db: Database, day: string, parts: readonly Part[]) {
  const insertFile = db.prepare(
    `INSERT INTO parquet_files (name, day, rows, bytes, sha256, created_at, moved)
     VALUES ($name, $day, $rows, $bytes, $sha256, $createdAt, 0)`
  );
  const insertKey = db.prepare(
    `INSERT INTO parquet_keys (airnode, template_id, name, first_timestamp, last_timestamp, row_start, row_end)
     VALUES ($airnode, $templateId, $name, $first, $last, $rowStart, $rowEnd)`
  );
  db.transaction(() => {
    for (const { name, rows, bytes, sha256, keys } of parts) {
      insertFile.run({ name, day, rows, bytes, sha256, createdAt: Date.now() });
      for (const key of keys) insertKey.run({ ...key, name });
    }
  })();
}

function deleteRows(db: Database, rows: readonly Pick<StoredRow, 'airnode' | 'templateId' | 'timestamp' | 'value'>[]) {
  const remove = db.prepare(
    `DELETE FROM datapoints
     WHERE airnode = $airnode AND template_id = $templateId AND timestamp = $timestamp AND value = $value`
  );
  let deleted = 0;
  for (let start = 0; start < rows.length; start += DELETE_BATCH) {
    deleted += db.transaction(() => {
      let changes = 0;
      for (const { airnode, templateId, timestamp, value } of rows.slice(start, start + DELETE_BATCH)) {
        changes += remove.run({ airnode, templateId, timestamp, value }).changes;
      }
      return changes;
    })();
  }
  return deleted;
}

// Deletes from SQLite exactly the rows a registered file holds, read back from the file itself, then marks it moved.
async function clearMoved(db: Database, dir: string, name: string, signal?: AbortSignal) {
  const { file, metadata } = await openFile(join(dir, name));
  let deleted = 0;
  let start = 0;
  for (const group of metadata.row_groups) {
    if (signal?.aborted) return deleted;
    const end = start + Number(group.num_rows);
    const rows = await readRows(file, metadata, start, end, ['airnode', 'template_id', 'timestamp', 'value']);
    deleted += deleteRows(db, rows);
    start = end;
    await yieldToLoop();
  }
  db.query('UPDATE parquet_files SET moved = 1 WHERE name = $name').run({ name });
  return deleted;
}

async function openFile(path: string) {
  const file = fileBuffer(path);
  return { file, metadata: await parquetMetadataAsync(file) };
}

export interface ParquetFile {
  name: string;
  day: string;
  rows: number;
  bytes: number;
  sha256: string;
}

// Read side, for the reader's read-only connection. Archives with no moved days have no registry tables, and a
// read-only connection can't add them, so every query first checks they exist.
export function openParquet(db: Database, dir: string | undefined) {
  const opened = new Map<string, Promise<{ file: AsyncBuffer; metadata: FileMetaData }>>();
  // ponytail: unbounded footer cache, about 100 KB per file; bound it (LRU) once an archive has thousands of files.
  const open = (name: string) => {
    let entry = opened.get(name);
    if (!entry) {
      entry = openFile(join(dir ?? '.', name));
      entry.catch(() => opened.delete(name));
      opened.set(name, entry);
    }
    return entry;
  };
  const ready = () => dir !== undefined && hasTable(db, 'parquet_keys') && hasTable(db, 'parquet_files');

  interface KeyFile {
    name: string;
    first: number;
    last: number;
    rowStart: number;
    rowEnd: number;
  }
  type Key = { airnode: Uint8Array; templateId: Uint8Array };
  const keyColumns = 'name, first_timestamp AS first, last_timestamp AS last, row_start AS rowStart, row_end AS rowEnd';

  // A key's rows from every file whose span overlaps [from, to], filtered to that range, in file order.
  async function rows(key: Key, from: number, to: number, columns: readonly Column[]) {
    if (!ready()) return [];
    const files = db
      .query<KeyFile, Key & { from: number; to: number }>(
        `SELECT ${keyColumns} FROM parquet_keys WHERE airnode = $airnode AND template_id = $templateId
           AND first_timestamp <= $to AND last_timestamp >= $from ORDER BY first_timestamp`
      )
      .all({ ...key, from, to });
    const result: StoredRow[] = [];
    for (const { name, rowStart, rowEnd } of files) {
      const { file, metadata } = await open(name);
      const read = await readRows(file, metadata, rowStart, rowEnd, columns);
      for (const row of read) if (row.timestamp >= from && row.timestamp <= to) result.push(row);
    }
    return result;
  }

  // The key's records at its latest timestamp at or before `at`, if that timestamp is at least `floor` (pass the
  // newest SQLite timestamp, so files that can't hold anything newer are never opened). Ties come back together.
  async function latest(key: Key, at: number, floor: number | null) {
    if (!ready()) return { timestamp: null, rows: [] as StoredRow[] };
    const files = db
      .query<KeyFile & { bound: number }, Key & { at: number; floor: number }>(
        `SELECT ${keyColumns}, min(last_timestamp, $at) AS bound FROM parquet_keys
         WHERE airnode = $airnode AND template_id = $templateId AND first_timestamp <= $at
           AND min(last_timestamp, $at) >= $floor
         ORDER BY bound DESC`
      )
      .all({ ...key, at, floor: floor ?? Number.MIN_SAFE_INTEGER });
    let best: number | null = null;
    let found: StoredRow[] = [];
    for (const { name, rowStart, rowEnd, bound } of files) {
      if (best !== null && bound < best) break;
      const { file, metadata } = await open(name);
      for (const row of await readRows(file, metadata, rowStart, rowEnd, ['timestamp', 'value', 'signature'])) {
        if (row.timestamp > at) continue;
        if (best === null || row.timestamp > best) {
          best = row.timestamp;
          found = [row];
        } else if (row.timestamp === best) {
          found.push(row);
        }
      }
    }
    return { timestamp: best, rows: found };
  }

  const earliest = (key: Key) => {
    if (!ready()) return null;
    return (
      db
        .query<{ t: number | null }, Key>(
          'SELECT min(first_timestamp) AS t FROM parquet_keys WHERE airnode = $airnode AND template_id = $templateId'
        )
        .get(key)?.t ?? null
    );
  };

  // Records signed before this time can be in files; everything after it is only in SQLite. Null with no files.
  const filedBefore = () => {
    if (!ready()) return null;
    const day = db.query<{ day: string | null }, []>('SELECT max(day) AS day FROM parquet_files').get()?.day ?? null;
    return day === null ? null : dayStart(day) + DAY_SECONDS;
  };

  const files = (): ParquetFile[] => {
    if (!ready()) return [];
    return db
      .query<ParquetFile, []>('SELECT name, day, rows, bytes, sha256 FROM parquet_files WHERE moved = 1 ORDER BY name')
      .all();
  };

  // The path of a registered, moved file, or null: only names from the registry ever reach the file system.
  const pathOf = (name: string) => (files().some((file) => file.name === name) ? join(dir ?? '.', name) : null);

  return { rows, latest, earliest, filedBefore, files, pathOf };
}

export type ParquetReader = ReturnType<typeof openParquet>;

// First look a minute after start (the archiver's first cycle runs undisturbed), then hourly: a day only becomes due
// at midnight UTC, so checking more often finds nothing.
const FIRST_MOVE_MS = 60_000;
const MOVE_EVERY_MS = 60 * 60 * 1000;

// Runs beside polling, never inside it. A failure is logged and tried again next hour; the records stay in SQLite.
export async function runMoves(options: Omit<MoveOptions, 'now'> & { signal: AbortSignal }) {
  let wait = FIRST_MOVE_MS;
  while (!options.signal.aborted) {
    const [stopped] = await go(() => sleep(wait, undefined, { signal: options.signal }));
    if (stopped) return;
    wait = MOVE_EVERY_MS;
    const [error, moved] = await go(() => moveDays(options));
    if (error) log.warn('move failed', { error: error.message });
    else if (moved.files.length > 0 || moved.deleted > 0) {
      log.info('days moved', { files: moved.files.length, written: moved.written, deleted: moved.deleted });
    }
  }
}
