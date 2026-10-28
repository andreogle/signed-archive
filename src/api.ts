import { ENDPOINTS, type Endpoint, isEndpoint } from './config.ts';
import { FEEDS, PROVIDER_SLOTS } from './feeds.ts';
import {
  decodeValue,
  formatPrice,
  type Gap,
  median,
  type PricePoint,
  type Reader,
  type SignedPrice,
} from './reader.ts';

// Response shapes, shared with the web app through type-only imports.
export interface FeedSummary {
  feed: string;
  providers: number;
  latest: number;
  median: string | null;
}
export interface FeedsResponse {
  endpoint: Endpoint;
  feeds: FeedSummary[];
}
export interface HistoryResponse {
  feed: string;
  endpoint: Endpoint;
  from: number;
  to: number;
  earliest: number | null;
  // `slot` is the provider's fixed colour slot (see PROVIDER_SLOTS), so the web app colours it the same everywhere.
  providers: { provider: string; slot: number; points: PricePoint[] }[];
  // When the archiver was not polling: missing points there are unknown, not unchanged.
  gaps: Gap[];
}
export interface MomentResponse {
  feed: string;
  endpoint: Endpoint;
  time: number;
  median: string | null;
  records: SignedPrice[];
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string) => json({ error }, status);

// Query strings are untrusted input: every parameter is checked before it reaches the reader.
function parseSeconds(value: string | null, fallback: number) {
  if (value === null) return fallback;
  return /^\d{1,12}$/.test(value) ? Number(value) : null;
}

function medianPrice(records: readonly SignedPrice[]) {
  const middle = median(records.map(({ encodedValue }) => decodeValue(encodedValue)));
  return middle === null ? null : formatPrice(middle);
}

// GET /api/feeds, /api/history and /api/at. Times are unix seconds, like the signed timestamps.
export function handleApi(reader: Reader, url: URL, now = Math.floor(Date.now() / 1000)): Response {
  const params = url.searchParams;
  const endpoint = params.get('endpoint') ?? 'public';
  if (!isEndpoint(endpoint)) return fail(400, `endpoint must be one of ${ENDPOINTS.join(', ')}`);

  if (url.pathname === '/api/feeds') {
    const feeds = [...FEEDS].flatMap(([feed, sources]): FeedSummary[] => {
      const records = reader.at(sources[endpoint], now);
      if (records.length === 0) return [];
      const latest = Math.max(...records.map(({ timestamp }) => Number(timestamp)));
      return [{ feed, providers: records.length, latest, median: medianPrice(records) }];
    });
    return json({ endpoint, feeds } satisfies FeedsResponse);
  }

  const feed = params.get('feed') ?? '';
  const sources = FEEDS.get(feed)?.[endpoint];
  if (!sources) return fail(404, 'unknown feed');

  if (url.pathname === '/api/history') {
    const to = parseSeconds(params.get('to'), now);
    const from = parseSeconds(params.get('from'), (to ?? now) - 24 * 60 * 60);
    if (from === null || to === null || from > to) return fail(400, 'from and to must be unix seconds, from <= to');
    const providers = reader
      .history(sources, from, to)
      .map((series) => ({ ...series, slot: PROVIDER_SLOTS.get(series.provider) ?? 0 }));
    const earliest = reader.earliest(sources);
    return json({
      feed,
      endpoint,
      from,
      to,
      earliest,
      providers,
      gaps: reader.gaps(from, to),
    } satisfies HistoryResponse);
  }

  if (url.pathname === '/api/at') {
    const time = parseSeconds(params.get('time'), now);
    if (time === null) return fail(400, 'time must be unix seconds');
    const records = reader.at(sources, time);
    return json({ feed, endpoint, time, median: medianPrice(records), records } satisfies MomentResponse);
  }

  return fail(404, 'not found');
}
