import type { Endpoint } from '../src/config.ts';

export const RANGES = { '1h': 3600, '6h': 6 * 3600, '24h': 24 * 3600, '7d': 7 * 24 * 3600, all: null } as const;
export type Range = keyof typeof RANGES;

export interface FeedSearch {
  feed: string;
  range: Range;
  endpoint: Endpoint;
  time?: number;
}

// At most 12 digits, like the server's parseSeconds, so the time is always a valid Date.
const isSeconds = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 1e12;
};

const isRange = (value: unknown): value is Range => typeof value === 'string' && Object.hasOwn(RANGES, value);

// Search params come from shared links, so anything unexpected falls back to a default instead of reaching the API.
export function parseFeedSearch(search: Record<string, unknown>): FeedSearch {
  const { feed, range, endpoint, time } = search;
  return {
    feed: typeof feed === 'string' && feed.length > 0 ? feed : 'ETH/USD',
    range: isRange(range) ? range : '24h',
    endpoint: endpoint === 'public-oev' ? 'public-oev' : 'public',
    time: isSeconds(time) ? time : undefined,
  };
}

// Counting conflicts reads every record in the range, so the server caps it at a week and there is no "all".
export const CONFLICT_RANGES = ['1h', '6h', '24h', '7d'] as const;
export type ConflictRange = (typeof CONFLICT_RANGES)[number];

export interface ConflictsSearch {
  range: ConflictRange;
}

const isConflictRange = (value: unknown): value is ConflictRange => {
  return (CONFLICT_RANGES as readonly unknown[]).includes(value);
};

export const parseConflictsSearch = (search: Record<string, unknown>): ConflictsSearch => {
  return { range: isConflictRange(search.range) ? search.range : '24h' };
};
