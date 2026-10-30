import { Database } from 'bun:sqlite';
import { type Address, type Hex, hexToBytes } from 'viem';
import type { FeedSource } from './catalog.ts';
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

// Read-only, so it can run beside the archiver: WAL mode lets readers and the writer work at once.
export function openReader(path: string) {
  const db = new Database(path, { readonly: true, strict: true });

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

  // Each provider's latest signed records at or before `at` (unix seconds), with everything needed to re-check them.
  // A provider has more than one record only if it signed different values for the same moment.
  function at(sources: readonly FeedSource[], at: number): SignedPrice[] {
    return sources.flatMap((source) => {
      return latestQuery.all({ ...keyOf(source), at }).map((row) => {
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
      });
    });
  }

  // Every record of the sources signed in [from, to] (unix seconds), oldest first, with everything needed to
  // re-check or replay it. Two values signed for the same moment both come back.
  function records(sources: readonly FeedSource[], from: number, to: number): SignedPrice[] {
    const rows = sources.flatMap((source) => {
      return rangeQuery.all({ ...keyOf(source), from, to }).map((row) => {
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
      });
    });
    return rows.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  }

  function history(sources: readonly FeedSource[], from: number, to: number) {
    const bucket = Math.max(1, Math.ceil((to - from) / MAX_POINTS));
    return sources.flatMap((source) => {
      const points = historyQuery
        .all({ ...keyOf(source), from, to, bucket })
        .map(({ timestamp, value }) => ({ timestamp, price: decodePrice(toHex(value)) }));
      return points.length > 0 ? [{ provider: source.provider, points }] : [];
    });
  }

  // Earliest record of any source, in unix seconds, or null when the archive has none.
  function earliest(sources: readonly FeedSource[]) {
    const times = sources.flatMap((source) => earliestQuery.get(keyOf(source))?.timestamp ?? []);
    return times.length > 0 ? Math.min(...times) : null;
  }

  // Every record of every (airnode, template, timestamp) that has more than one signed value in [from, to] (unix
  // seconds), with the Signed API that served it: matched through the poll that saved it. Records merged or repaired
  // from another archive have no matching poll, so their source is null.
  function conflictRecords(from: number, to: number) {
    const sourced = hasTable(db, 'polls') && hasColumn(db, 'polls', 'source');
    const source = sourced ? 'p.source' : 'NULL';
    const join = sourced
      ? 'LEFT JOIN polls p ON p.airnode = d.airnode AND p.endpoint = d.endpoint AND p.fetched_at = d.fetched_at'
      : '';
    return db
      .query<
        {
          airnode: string;
          templateId: string;
          timestamp: number;
          endpoint: string;
          value: string;
          source: string | null;
        },
        { from: number; to: number }
      >(
        `WITH conflicted AS (
           SELECT airnode, template_id, timestamp FROM datapoints WHERE timestamp BETWEEN $from AND $to
           GROUP BY airnode, template_id, timestamp HAVING count(*) > 1
         )
         SELECT hex(d.airnode) AS airnode, hex(d.template_id) AS templateId, d.timestamp, d.endpoint,
                hex(d.value) AS value, ${source} AS source
         FROM datapoints d JOIN conflicted c
           ON c.airnode = d.airnode AND c.template_id = d.template_id AND c.timestamp = d.timestamp
         ${join}
         ORDER BY d.airnode, d.template_id, d.timestamp, d.value`
      )
      .all({ from, to })
      .map((row) => ({
        ...row,
        airnode: toHex(row.airnode),
        templateId: toHex(row.templateId),
        value: toHex(row.value),
      }));
  }

  // How many distinct signed moments (template and timestamp) each airnode and endpoint has in [from, to].
  function momentCounts(from: number, to: number) {
    return db
      .query<{ airnode: string; endpoint: string; moments: number }, { from: number; to: number }>(
        `SELECT hex(airnode) AS airnode, endpoint, count(*) AS moments FROM (
           SELECT DISTINCT airnode, endpoint, template_id, timestamp FROM datapoints WHERE timestamp BETWEEN $from AND $to
         ) GROUP BY airnode, endpoint`
      )
      .all({ from, to })
      .map((row) => ({ ...row, airnode: toHex(row.airnode) }));
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
    return subtractCovered(union([...head, ...found, ...tail]), covered, GAP_SECONDS);
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
