import { Database } from 'bun:sqlite';
import { type Hex, hexToBytes } from 'viem';
import type { FeedSource } from './feeds.ts';
import { decodePrice } from './price.ts';
import type { SignedDatum } from './signed-data.ts';
import { hasTable } from './store.ts';

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

// Polls are stored in unix milliseconds; everything the reader returns is in unix seconds. The window includes the
// last poll before the range and the first after it, so a gap that crosses either edge is found, then clipped.
const GAPS = `
  SELECT max(previous, $from) / 1000 AS "from", min(fetched_at, $to) / 1000 AS "to" FROM (
    SELECT fetched_at, lag(fetched_at) OVER (ORDER BY fetched_at) AS previous FROM polls
    WHERE fetched_at BETWEEN coalesce((SELECT max(fetched_at) FROM polls WHERE fetched_at < $from), $from)
                         AND coalesce((SELECT min(fetched_at) FROM polls WHERE fetched_at > $to), $to)
  ) WHERE fetched_at - previous > $gap AND previous < $to AND fetched_at > $from`;
const POLL_RANGE = 'SELECT min(fetched_at) / 1000 AS first, max(fetched_at) / 1000 AS last FROM polls';

export interface Gap {
  from: number;
  to: number;
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

  // Stretches inside [from, to] when the archiver was not polling, in unix seconds. Coverage is only
  // known since the first recorded poll, so earlier time is never reported as a gap.
  // When the archiver last recorded a request, in unix milliseconds, or null if it never has.
  function lastPoll() {
    if (!hasTable(db, 'polls')) return null;
    return db.query<{ last: number | null }, []>('SELECT max(fetched_at) AS last FROM polls').get()?.last ?? null;
  }

  function gaps(from: number, to: number): Gap[] {
    if (!hasTable(db, 'polls')) return [];
    const range = db.query<{ first: number | null; last: number | null }, []>(POLL_RANGE).get();
    if (!range || range.first === null || range.last === null) return [];
    const { first, last } = range;
    const start = Math.max(from, first);
    const found = db
      .query<Gap, { from: number; to: number; gap: number }>(GAPS)
      .all({ from: start * 1000, to: to * 1000, gap: GAP_SECONDS * 1000 });
    return last < to - GAP_SECONDS ? [...found, { from: Math.max(last, start), to }] : found;
  }

  return { at, records, history, earliest, gaps, lastPoll, close: () => db.close() };
}

export type Reader = ReturnType<typeof openReader>;
