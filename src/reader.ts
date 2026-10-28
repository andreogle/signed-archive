import { Database } from 'bun:sqlite';
import { formatUnits, type Hex, hexToBigInt, hexToBytes } from 'viem';
import type { FeedSource } from './feeds.ts';
import type { SignedDatum } from './signed-data.ts';

// Values are int256 with 18 decimals, the encoding every API3 price feed uses.
const DECIMALS = 18;
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

// Polls are stored in unix milliseconds; everything the reader returns is in unix seconds.
const GAPS = `
  SELECT previous / 1000 AS "from", fetched_at / 1000 AS "to" FROM (
    SELECT fetched_at, lag(fetched_at) OVER (ORDER BY fetched_at) AS previous FROM polls
    WHERE fetched_at BETWEEN $from AND $to
  ) WHERE fetched_at - previous > $gap`;
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
export const decodeValue = (encodedValue: Hex) => hexToBigInt(encodedValue, { signed: true });
export const formatPrice = (value: bigint) => formatUnits(value, DECIMALS);
const decodePrice = (encodedValue: Hex) => formatPrice(decodeValue(encodedValue));

// Read-only, so it can run beside the archiver: WAL mode lets readers and the writer work at once.
export function openReader(path: string) {
  const db = new Database(path, { readonly: true, strict: true });

  const latestQuery = db.prepare<Row, { airnode: Uint8Array; templateId: Uint8Array; at: number }>(
    `SELECT timestamp, hex(value) AS value, hex(signature) AS signature FROM datapoints
     WHERE airnode = $airnode AND template_id = $templateId AND timestamp <= $at
     ORDER BY timestamp DESC LIMIT 1`
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
  const earliestQuery = db.prepare<{ timestamp: number }, { airnode: Uint8Array; templateId: Uint8Array }>(
    `SELECT timestamp FROM datapoints WHERE airnode = $airnode AND template_id = $templateId
     ORDER BY timestamp LIMIT 1`
  );

  const keyOf = ({ airnode, templateId }: FeedSource) => {
    return { airnode: hexToBytes(airnode), templateId: hexToBytes(templateId) };
  };

  // Each provider's latest signed record at or before `at` (unix seconds), with everything needed to re-check it.
  function at(sources: readonly FeedSource[], at: number): SignedPrice[] {
    return sources.flatMap((source) => {
      const row = latestQuery.get({ ...keyOf(source), at });
      if (!row) return [];
      const encodedValue = toHex(row.value);
      return [
        {
          provider: source.provider,
          airnode: source.airnode,
          templateId: source.templateId,
          timestamp: String(row.timestamp),
          encodedValue,
          signature: toHex(row.signature),
          price: decodePrice(encodedValue),
        },
      ];
    });
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
  function gaps(from: number, to: number): Gap[] {
    // Archives written before polls were recorded have no table, and a read-only reader can't add it.
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'polls'").get()) return [];
    const range = db.query<{ first: number | null; last: number | null }, []>(POLL_RANGE).get();
    if (!range || range.first === null || range.last === null) return [];
    const { first, last } = range;
    const start = Math.max(from, first);
    const found = db
      .query<Gap, { from: number; to: number; gap: number }>(GAPS)
      .all({ from: start * 1000, to: to * 1000, gap: GAP_SECONDS * 1000 });
    return last < to - GAP_SECONDS ? [...found, { from: Math.max(last, start), to }] : found;
  }

  return { at, history, earliest, gaps, close: () => db.close() };
}

export type Reader = ReturnType<typeof openReader>;

// Middle value, or the mean of the two middle values for an even count, as Api3ServerV1 aggregates beacon sets.
export function median(values: readonly bigint[]): bigint | null {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) return null;
  const lower = sorted[middle - 1];
  return sorted.length % 2 === 1 || lower === undefined ? upper : (lower + upper) / 2n;
}
