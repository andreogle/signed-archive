import { Database } from 'bun:sqlite';
import { type Address, bytesToHex, type Hex, hexToBytes } from 'viem';
import type { FeedSource } from './catalog.ts';
import { openParquet, type StoredRow } from './parquet.ts';
import { decodePrice } from './price.ts';
import type { SignedDatum } from './signed-data.ts';
import { hasColumn, hasTable } from './store.ts';

// Charts get at most this many points per provider; longer ranges keep the last record per bucket.
export const MAX_POINTS = 500;
// No poll of any target for this long means the archiver was down. Polls normally arrive every
// interval / targets seconds (about 1.4 s by default).
// ponytail: fixed threshold, derive it from the configured interval if intervals over ~5 min become common.
export const GAP_SECONDS = 180;

export interface SignedPrice extends SignedDatum {
  provider: string;
  price: string;
}

// Polls are stored in unix milliseconds; everything the reader returns is in unix seconds. Gaps are per airnode and
// endpoint. The window includes the last poll before the range and the first after it, so a gap that crosses either
// edge is found, then clipped. `$ok` limits it to successful polls (1) or counts any poll (0).
const POLL_GAPS = `
  SELECT max(previous, $from) / 1000 AS "from", min(fetched_at, $to) / 1000 AS "to" FROM (
    SELECT fetched_at, lag(fetched_at) OVER (ORDER BY fetched_at) AS previous FROM polls
    WHERE airnode = $airnode AND endpoint = $endpoint AND (status = 200 OR $ok = 0)
      AND fetched_at BETWEEN coalesce((SELECT max(fetched_at) FROM polls WHERE airnode = $airnode
                                         AND endpoint = $endpoint AND (status = 200 OR $ok = 0) AND fetched_at < $from), $from)
                         AND coalesce((SELECT min(fetched_at) FROM polls WHERE airnode = $airnode
                                         AND endpoint = $endpoint AND (status = 200 OR $ok = 0) AND fetched_at > $to), $to)
  ) WHERE fetched_at - previous > $gap AND previous < $to AND fetched_at > $from`;
const POLL_RANGE = `
  SELECT min(fetched_at) / 1000 AS first, max(fetched_at) / 1000 AS last FROM polls
  WHERE airnode = $airnode AND endpoint = $endpoint AND (status = 200 OR $ok = 0)`;

// Overlapping or touching stretches merged into one, in order.
export function union(gaps: readonly Gap[]): Gap[] {
  const merged: Gap[] = [];
  for (const gap of [...gaps].sort((a, b) => a.from - b.from)) {
    const last = merged.at(-1);
    if (last && gap.from <= last.to) last.to = Math.max(last.to, gap.to);
    else merged.push({ ...gap });
  }
  return merged;
}

export interface Gap {
  from: number;
  to: number;
}

// Parts of each gap not covered by any of `covers`. A gap a cover cuts is split, and leftover pieces shorter than
// `minPiece` are dropped: covers are signed times, a little earlier than the fetch times gaps are measured in, so a
// filled gap would otherwise leave a sliver at its end. A gap no cover touches is kept whatever its length.
export function subtractCovered(gaps: readonly Gap[], covers: readonly Gap[], minPiece = 0): Gap[] {
  let pieces = gaps.map((gap) => ({ ...gap, cut: false }));
  for (const cover of covers) {
    pieces = pieces.flatMap((gap) => {
      if (cover.to <= gap.from || cover.from >= gap.to) return [gap];
      return [
        { from: gap.from, to: cover.from, cut: true },
        { from: cover.to, to: gap.to, cut: true },
      ].filter((piece) => piece.to > piece.from);
    });
  }
  return pieces.filter(({ from, to, cut }) => !cut || to - from >= minPiece).map(({ from, to }) => ({ from, to }));
}

export interface PricePoint {
  timestamp: number;
  price: string;
}

interface Row {
  timestamp: number;
  value: string;
  signature: string;
}

const toHex = (hex: string) => `0x${hex.toLowerCase()}` as Hex;

// One entry per airnode and template, so a template listed under two feed names is read once.
const unique = (sources: readonly FeedSource[]) => {
  return [
    ...new Map(sources.map((source) => [`${source.airnode}:${source.templateId}`.toLowerCase(), source])).values(),
  ];
};

// Rows from SQLite and from Parquet files, as one sorted list with each record once. A record can be in both while
// it is being moved, or after a stale feed or a peer served it again.
function mergeRows<T extends { timestamp: number; value: string }>(...lists: T[][]) {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const row of lists.flat()) {
    const key = `${row.timestamp}:${row.value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  return merged.sort((a, b) => a.timestamp - b.timestamp || (a.value.toLowerCase() < b.value.toLowerCase() ? -1 : 1));
}

const fromFile = (row: StoredRow) => {
  return {
    timestamp: row.timestamp,
    value: bytesToHex(row.value).slice(2),
    signature: bytesToHex(row.signature).slice(2),
    endpoint: row.endpoint,
    source: row.source,
  };
};

export interface ReaderOptions {
  // Where moved days' Parquet files are; without it the reader sees only what is still in SQLite.
  parquetDir?: string | undefined;
}

// Read-only, so it can run beside the archiver: WAL mode lets readers and the writer work at once. Records of moved
// days are read from their Parquet files (see src/parquet.ts), so every answer covers both.
export function openReader(path: string, { parquetDir }: ReaderOptions = {}) {
  const db = new Database(path, { readonly: true, strict: true });
  const parquet = openParquet(db, parquetDir);

  // Every record at the source's latest timestamp, not just one: two values signed for the same moment are the
  // equivocation evidence the archive exists to keep, so the reader must never hide either.
  const latestQuery = db.prepare<Row, { airnode: Uint8Array; templateId: Uint8Array; at: number }>(
    `SELECT timestamp, hex(value) AS value, hex(signature) AS signature FROM datapoints
     WHERE airnode = $airnode AND template_id = $templateId AND timestamp = (
       SELECT max(timestamp) FROM datapoints
       WHERE airnode = $airnode AND template_id = $templateId AND timestamp <= $at
     )
     ORDER BY value`
  );
  // SQLite returns the row holding max(timestamp) for the bare `value` column, so each bucket keeps its last record.
  const historyQuery = db.prepare<
    Omit<Row, 'signature'>,
    { airnode: Uint8Array; templateId: Uint8Array; from: number; to: number; bucket: number }
  >(
    `SELECT max(timestamp) AS timestamp, hex(value) AS value FROM datapoints
     WHERE airnode = $airnode AND template_id = $templateId AND timestamp BETWEEN $from AND $to
     GROUP BY timestamp / $bucket ORDER BY timestamp`
  );
  const rangeQuery = db.prepare<Row, { airnode: Uint8Array; templateId: Uint8Array; from: number; to: number }>(
    `SELECT timestamp, hex(value) AS value, hex(signature) AS signature FROM datapoints
     WHERE airnode = $airnode AND template_id = $templateId AND timestamp BETWEEN $from AND $to
     ORDER BY timestamp, value`
  );
  const earliestQuery = db.prepare<{ timestamp: number }, { airnode: Uint8Array; templateId: Uint8Array }>(
    `SELECT timestamp FROM datapoints WHERE airnode = $airnode AND template_id = $templateId
     ORDER BY timestamp LIMIT 1`
  );

  const keyOf = ({ airnode, templateId }: FeedSource) => {
    return { airnode: hexToBytes(airnode), templateId: hexToBytes(templateId) };
  };

  const toPrice = (source: FeedSource, row: Row): SignedPrice => {
    const encodedValue = toHex(row.value);
    return {
      provider: source.provider,
      airnode: source.airnode,
      templateId: source.templateId,
      timestamp: String(row.timestamp),
      encodedValue,
      signature: toHex(row.signature),
      price: decodePrice(encodedValue),
    };
  };

  // Each provider's latest signed records at or before `at` (unix seconds), with everything needed to re-check them.
  // A provider has more than one record only if it signed different values for the same moment.
  async function at(sources: readonly FeedSource[], at: number): Promise<SignedPrice[]> {
    const perSource = await Promise.all(
      sources.map(async (source) => {
        const live = latestQuery.all({ ...keyOf(source), at });
        const liveAt = live[0]?.timestamp ?? null;
        const filed = await parquet.latest(keyOf(source), at, liveAt);
        const newest = filed.timestamp !== null && (liveAt === null || filed.timestamp > liveAt) ? [] : live;
        const fromFiles = filed.timestamp !== null && filed.timestamp >= (liveAt ?? 0) ? filed.rows.map(fromFile) : [];
        return mergeRows(newest, fromFiles).map((row) => toPrice(source, row));
      })
    );
    return perSource.flat();
  }

  // Every record of the sources signed in [from, to] (unix seconds), oldest first, with everything needed to
  // re-check or replay it. Two values signed for the same moment both come back.
  async function records(sources: readonly FeedSource[], from: number, to: number): Promise<SignedPrice[]> {
    const perSource = await Promise.all(
      sources.map(async (source) => {
        const filed = await parquet.rows(keyOf(source), from, to, ['timestamp', 'value', 'signature']);
        const rows = mergeRows(rangeQuery.all({ ...keyOf(source), from, to }), filed.map(fromFile));
        return rows.map((row) => toPrice(source, row));
      })
    );
    return perSource.flat().sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  }

  // At most `maxPoints` per provider: longer ranges keep the last record of each bucket.
  // ponytail: a moved stretch is bucketed after reading every record in it, about 3,000 per feed and day per
  // provider; precompute per-file bucket summaries if month-long charts over moved days get slow.
  async function history(sources: readonly FeedSource[], from: number, to: number, maxPoints = MAX_POINTS) {
    const bucket = Math.max(1, Math.ceil((to - from) / maxPoints));
    const perSource = await Promise.all(
      sources.map(async (source) => {
        // The last record of each bucket, from whichever store holds the later one.
        const last = new Map<number, { timestamp: number; value: string }>();
        const keep = (row: { timestamp: number; value: string }) => {
          const slot = Math.floor(row.timestamp / bucket);
          const held = last.get(slot);
          if (!held || row.timestamp > held.timestamp) last.set(slot, row);
        };
        for (const row of historyQuery.all({ ...keyOf(source), from, to, bucket })) keep(row);
        for (const row of await parquet.rows(keyOf(source), from, to, ['timestamp', 'value'])) keep(fromFile(row));
        const points = [...last.values()]
          .sort((a, b) => a.timestamp - b.timestamp)
          .map(({ timestamp, value }) => ({ timestamp, price: decodePrice(toHex(value)) }))
          // Buckets are aligned to multiples of their size, so a range can touch one more than maxPoints; keep the newest.
          .slice(-maxPoints);
        return points.length > 0 ? [{ provider: source.provider, points }] : [];
      })
    );
    return perSource.flat();
  }

  // Earliest record of any source, in unix seconds, or null when the archive has none.
  function earliest(sources: readonly FeedSource[]) {
    const times = sources.flatMap((source) => {
      return [earliestQuery.get(keyOf(source))?.timestamp, parquet.earliest(keyOf(source))].flatMap((t) => t ?? []);
    });
    return times.length > 0 ? Math.min(...times) : null;
  }

  // Records signed before `filedBefore` may be in Parquet files as well as SQLite (only late arrivals and records
  // being moved are left there), so that part of a range is read from both and grouped here. After it, everything is
  // in SQLite and grouped in SQL. Returns the two parts of [from, to]; either may be empty (from > to).
  const split = (from: number, to: number) => {
    const before = parquet.filedBefore();
    if (before === null) return { filed: { from: 1, to: 0 }, live: { from, to } };
    return { filed: { from, to: Math.min(to, before - 1) }, live: { from: Math.max(from, before), to } };
  };

  type SourcedRow = { timestamp: number; endpoint: string; value: string; source: string | null };
  // Every record of one source in a stretch that may be filed, from both stores, each record once.
  const allRows = async (source: FeedSource, from: number, to: number, sourced: boolean): Promise<SourcedRow[]> => {
    if (from > to) return [];
    const live = db
      .query<SourcedRow, { airnode: Uint8Array; templateId: Uint8Array; from: number; to: number }>(
        `SELECT d.timestamp, d.endpoint, hex(d.value) AS value, ${sourced ? 'p.source' : 'NULL'} AS source
         FROM datapoints d
         ${sourced ? 'LEFT JOIN polls p ON p.airnode = d.airnode AND p.endpoint = d.endpoint AND p.fetched_at = d.fetched_at' : ''}
         WHERE d.airnode = $airnode AND d.template_id = $templateId AND d.timestamp BETWEEN $from AND $to`
      )
      .all({ ...keyOf(source), from, to });
    const filed = (await parquet.rows(keyOf(source), from, to, ['timestamp', 'value', 'endpoint', 'source'])).map(
      (row) => {
        const { timestamp, value, endpoint, source: servedBy } = fromFile(row);
        return { timestamp, endpoint, value, source: servedBy };
      }
    );
    return mergeRows(live, filed);
  };

  // Every record of the sources' (airnode, template, timestamp) moments that have more than one signed value in
  // [from, to] (unix seconds), with the Signed API that served it: matched through the poll that saved it (or kept in
  // the Parquet file). Records merged or repaired from another archive have no matching poll, so their source is null.
  // Each source is read on its key, so the cost follows the range, not the size of the archive.
  async function conflictRecords(sources: readonly FeedSource[], from: number, to: number) {
    const sourced = hasTable(db, 'polls') && hasColumn(db, 'polls', 'source');
    const query = db.prepare<SourcedRow, { airnode: Uint8Array; templateId: Uint8Array; from: number; to: number }>(
      `WITH conflicted AS (
         SELECT timestamp FROM datapoints
         WHERE airnode = $airnode AND template_id = $templateId AND timestamp BETWEEN $from AND $to
         GROUP BY timestamp HAVING count(*) > 1
       )
       SELECT d.timestamp, d.endpoint, hex(d.value) AS value, ${sourced ? 'p.source' : 'NULL'} AS source
       FROM conflicted c JOIN datapoints d
         ON d.airnode = $airnode AND d.template_id = $templateId AND d.timestamp = c.timestamp
       ${sourced ? 'LEFT JOIN polls p ON p.airnode = d.airnode AND p.endpoint = d.endpoint AND p.fetched_at = d.fetched_at' : ''}
       ORDER BY d.timestamp, d.value`
    );
    const parts = split(from, to);
    const perSource = await Promise.all(
      unique(sources).map(async (source) => {
        const filed = await allRows(source, parts.filed.from, parts.filed.to, sourced);
        const values = new Map<number, number>();
        for (const row of filed) values.set(row.timestamp, (values.get(row.timestamp) ?? 0) + 1);
        const conflicted = filed.filter((row) => (values.get(row.timestamp) ?? 0) > 1);
        const live = parts.live.from <= parts.live.to ? query.all({ ...keyOf(source), ...parts.live }) : [];
        return [...conflicted, ...live].map((row) => {
          return { ...row, value: toHex(row.value), airnode: source.airnode, templateId: source.templateId };
        });
      })
    );
    return perSource.flat();
  }

  // How many distinct signed moments (template and second) each airnode and endpoint has in [from, to].
  async function momentCounts(sources: readonly FeedSource[], from: number, to: number) {
    const query = db.prepare<
      { endpoint: string; moments: number },
      { airnode: Uint8Array; templateId: Uint8Array; from: number; to: number }
    >(
      `SELECT endpoint, count(DISTINCT timestamp) AS moments FROM datapoints
       WHERE airnode = $airnode AND template_id = $templateId AND timestamp BETWEEN $from AND $to GROUP BY endpoint`
    );
    const parts = split(from, to);
    const counts = new Map<string, { airnode: Address; endpoint: string; moments: number }>();
    const add = (source: FeedSource, endpoint: string, moments: number) => {
      const key = `${source.airnode.toLowerCase()}:${endpoint}`;
      const count = counts.get(key) ?? { airnode: source.airnode, endpoint, moments: 0 };
      count.moments += moments;
      counts.set(key, count);
    };
    for (const source of unique(sources)) {
      const filed = new Map<string, Set<number>>();
      for (const row of await allRows(source, parts.filed.from, parts.filed.to, false)) {
        filed.set(row.endpoint, (filed.get(row.endpoint) ?? new Set()).add(row.timestamp));
      }
      for (const [endpoint, moments] of filed) add(source, endpoint, moments.size);
      if (parts.live.from > parts.live.to) continue;
      for (const { endpoint, moments } of query.all({ ...keyOf(source), ...parts.live }))
        add(source, endpoint, moments);
    }
    return [...counts.values()];
  }

  // When the archiver last recorded a request, in unix milliseconds, or null if it never has.
  function lastPoll() {
    if (!hasTable(db, 'polls')) return null;
    return db.query<{ last: number | null }, []>('SELECT max(fetched_at) AS last FROM polls').get()?.last ?? null;
  }

  // Where this archive has nothing for one airnode and endpoint in [from, to] (unix seconds): stretches longer than
  // GAP_SECONDS without a poll, minus what peers filled. `ok` counts only successful polls. `beforeFirst` decides
  // whether time before the first poll counts as missing (true when telling a peer what this archive lacks) or as
  // unknown and left out (false for the explorer, which can't call the time before an archive existed a gap).
  function missing(airnode: Address, endpoint: string, from: number, to: number, ok: boolean, beforeFirst: boolean) {
    if (!hasTable(db, 'polls')) return beforeFirst ? [{ from, to }] : [];
    const key = { airnode: hexToBytes(airnode), endpoint, ok: ok ? 1 : 0 };
    const range = db.query<{ first: number | null; last: number | null }, typeof key>(POLL_RANGE).get(key);
    if (!range || range.first === null || range.last === null) return beforeFirst ? [{ from, to }] : [];
    const { first, last } = range;
    const start = Math.max(from, first);
    const found =
      start > to
        ? []
        : db
            .query<Gap, typeof key & { from: number; to: number; gap: number }>(POLL_GAPS)
            .all({ ...key, from: start * 1000, to: to * 1000, gap: GAP_SECONDS * 1000 });
    const head = beforeFirst && first > from ? [{ from, to: Math.min(first, to) }] : [];
    const tail = last < to - GAP_SECONDS ? [{ from: Math.max(last, start), to }] : [];
    // A stretch a peer filled is history like any other: its records were checked like the archiver's own.
    const covered = hasTable(db, 'peer_coverage')
      ? db
          .query<Gap, { airnode: Uint8Array; endpoint: string; from: number; to: number }>(
            `SELECT "from", "to" FROM peer_coverage
             WHERE airnode = $airnode AND endpoint = $endpoint AND "to" >= $from AND "from" <= $to`
          )
          .all({ airnode: key.airnode, endpoint, from, to })
      : [];
    // Sliver smoothing is only for the chart, never for coverage advertised to another archive.
    return subtractCovered(union([...head, ...found, ...tail]), covered, beforeFirst ? 0 : GAP_SECONDS);
  }

  // Stretches inside [from, to] when this archive has no data for some provider of a feed (`sources`, all on one
  // endpoint), in unix seconds, for the explorer to shade. A stretch stays shaded until every provider is covered,
  // by this archive's own polls or by what peers filled. Time before an airnode's first poll is unknown, not a gap.
  function gaps(sources: readonly FeedSource[], endpoint: string, from: number, to: number): Gap[] {
    const airnodes = [...new Set(sources.map(({ airnode }) => airnode.toLowerCase() as Address))];
    return union(airnodes.flatMap((airnode) => missing(airnode, endpoint, from, to, false, false)));
  }

  // What this archive lacks for one airnode and endpoint in [from, to], told to a peer asking for records so it can
  // tell "nothing was signed" from "this archive wasn't watching either". Only successful polls count as watching.
  const uncovered = (airnode: Address, endpoint: string, from: number, to: number) => {
    return missing(airnode, endpoint, from, to, true, true);
  };

  return {
    // Moved days' files, for serving them as downloads.
    parquetFiles: parquet.files,
    parquetPath: parquet.pathOf,
    at,
    records,
    history,
    earliest,
    gaps,
    uncovered,
    lastPoll,
    conflictRecords,
    momentCounts,
    close: () => db.close(),
  };
}

export type Reader = ReturnType<typeof openReader>;
