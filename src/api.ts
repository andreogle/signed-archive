import { type Address, isAddress } from 'viem';
import type { Catalog } from './catalog.ts';
import { ENDPOINTS, type Endpoint, isEndpoint } from './config.ts';
import { type ConflictSummary, summarizeConflicts } from './conflicts.ts';
import { medianPrice } from './price.ts';
import type { Gap, PricePoint, Reader, SignedPrice } from './reader.ts';
import type { SignedDatum } from './signed-data.ts';

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
  // `slot` is the provider's fixed colour slot (see catalog.slots), so the web app colours it the same everywhere.
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

// GET /api/records: what another archive asks for when it missed a stretch. Windows are short so a response stays
// small; the asking side splits a long gap into windows.
export const PEER_WINDOW_SECONDS = 900;
export interface RecordsResponse {
  airnode: Address;
  endpoint: Endpoint;
  from: number;
  to: number;
  // Where this archive itself has nothing in the window (no successful poll for longer than the gap threshold, and
  // nothing filled from its own peers), so the asker can tell "nothing was signed" from "this archive missed it too".
  uncovered: Gap[];
  // True when `uncovered` is empty. Kept for archives that only read this field.
  watched: boolean;
  records: SignedDatum[];
}

// GET /api/conflicts: moments when a provider signed more than one value for one feed and second, per provider and
// endpoint. It reads every record in the range, so the range is capped and the web app asks for it rarely.
export const MAX_CONFLICT_SECONDS = 7 * 24 * 60 * 60;
export interface ConflictsResponse {
  from: number;
  to: number;
  summaries: ConflictSummary[];
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string) => json({ error }, status);

// Query strings are untrusted input: every parameter is checked before it reaches the reader.
function parseSeconds(value: string | null, fallback: number) {
  if (value === null) return fallback;
  return /^\d{1,12}$/.test(value) ? Number(value) : null;
}

const providerCount = (records: readonly SignedPrice[]) => new Set(records.map(({ provider }) => provider)).size;

// GET /api/feeds, /api/history and /api/at. Times are unix seconds, like the signed timestamps.
export function handleApi(reader: Reader, catalog: Catalog, url: URL, now = Math.floor(Date.now() / 1000)): Response {
  // The airnodes and feeds this archive keeps, so the web app checks records against the same lists.
  if (url.pathname === '/api/catalog') return json(catalog.input);

  const params = url.searchParams;
  const endpoint = params.get('endpoint') ?? 'public';
  if (!isEndpoint(endpoint)) return fail(400, `endpoint must be one of ${ENDPOINTS.join(', ')}`);

  if (url.pathname === '/api/feeds') {
    const feeds = [...catalog.feeds].flatMap(([feed, sources]): FeedSummary[] => {
      const records = reader.at(sources[endpoint], now);
      if (records.length === 0) return [];
      const latest = Math.max(...records.map(({ timestamp }) => Number(timestamp)));
      return [{ feed, providers: providerCount(records), latest, median: medianPrice(records) }];
    });
    return json({ endpoint, feeds } satisfies FeedsResponse);
  }

  if (url.pathname === '/api/records') {
    const airnode = params.get('airnode') ?? '';
    // 400, not 404: the asking peer reads 400 as final, and a catalog that differs from ours stays different.
    const known = isAddress(airnode) && catalog.knows(airnode);
    if (!known) return fail(400, 'unknown airnode');
    const from = parseSeconds(params.get('from'), -1);
    const to = parseSeconds(params.get('to'), -1);
    if (from === null || to === null || from < 0 || to < from || to - from > PEER_WINDOW_SECONDS) {
      return fail(400, `from and to must be unix seconds, from <= to, at most ${PEER_WINDOW_SECONDS} s apart`);
    }
    const records = reader
      .records(catalog.sourcesOfAirnode(airnode, endpoint), from, to)
      .map(({ airnode, templateId, timestamp, encodedValue, signature }) => {
        return { airnode, templateId, timestamp, encodedValue, signature };
      });
    const uncovered = reader.uncovered(airnode, endpoint, from, to);
    return json({
      airnode,
      endpoint,
      from,
      to,
      uncovered,
      watched: uncovered.length === 0,
      records,
    } satisfies RecordsResponse);
  }

  if (url.pathname === '/api/conflicts') {
    const to = parseSeconds(params.get('to'), now);
    const from = parseSeconds(params.get('from'), (to ?? now) - 24 * 60 * 60);
    if (from === null || to === null || from > to || to - from > MAX_CONFLICT_SECONDS) {
      return fail(400, `from and to must be unix seconds, from <= to, at most ${MAX_CONFLICT_SECONDS} s apart`);
    }
    return json({ from, to, summaries: summarizeConflicts(reader, catalog, from, to) } satisfies ConflictsResponse);
  }

  const feed = params.get('feed') ?? '';
  const sources = catalog.feeds.get(feed)?.[endpoint];
  if (!sources) return fail(404, 'unknown feed');

  if (url.pathname === '/api/history') {
    const to = parseSeconds(params.get('to'), now);
    const requested = parseSeconds(params.get('from'), (to ?? now) - 24 * 60 * 60);
    if (requested === null || to === null || requested > to) {
      return fail(400, 'from and to must be unix seconds, from <= to');
    }
    // Start at the first record, so a range like "all" (from=0) spends its points on data, not empty decades.
    const earliest = reader.earliest(sources);
    const from = Math.min(to, Math.max(requested, earliest ?? requested));
    const providers = reader
      .history(sources, from, to)
      .map((series) => ({ ...series, slot: catalog.slots.get(series.provider) ?? 0 }));
    return json({
      feed,
      endpoint,
      from,
      to,
      earliest,
      providers,
      gaps: reader.gaps(sources, endpoint, from, to),
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
