import type { Endpoint } from '../src/config.ts';

export const RANGES = { '1h': 3600, '6h': 6 * 3600, '24h': 24 * 3600, '7d': 7 * 24 * 3600, all: null } as const;
export type Range = keyof typeof RANGES;

export interface FeedSearch {
  feed: string;
  range: Range;
  endpoint: Endpoint;
  time?: number;
}

const isRange = (value: unknown): value is Range => typeof value === 'string' && Object.hasOwn(RANGES, value);

// Search params come from shared links, so anything unexpected falls back to a default instead of reaching the API.
export function parseFeedSearch(search: Record<string, unknown>): FeedSearch {
  const { feed, range, endpoint, time } = search;
  return {
    feed: typeof feed === 'string' && feed.length > 0 ? feed : 'ETH/USD',
    range: isRange(range) ? range : '24h',
    endpoint: endpoint === 'public-oev' ? 'public-oev' : 'public',
    time: typeof time === 'number' && Number.isInteger(time) && time > 0 ? time : undefined,
  };
}

export interface ConflictsSearch {
  range: Range;
}

export const parseConflictsSearch = (search: Record<string, unknown>): ConflictsSearch => {
  return { range: isRange(search.range) ? search.range : '24h' };
};
