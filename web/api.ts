import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';
import type { ConflictsResponse, FeedsResponse, HistoryResponse, MomentResponse } from '../src/api.ts';
import { type Catalog, type CatalogInput, createCatalog } from '../src/catalog.ts';
import type { Endpoint } from '../src/config.ts';
import type { SignedPrice } from '../src/reader.ts';
import { hasValidSignature } from '../src/signed-data.ts';
import { RANGES, type Range } from './search.ts';

// The archiver adds records about once a minute; refreshing twice as often keeps live views at most half a cycle
// behind. TanStack Query pauses the refresh while the tab is hidden.
export const REFRESH_MS = 30_000;

async function get<T>(path: string, query: Record<string, string | number>): Promise<T> {
  const search = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
  const response = await fetch(`${path}?${search}`);
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : '';
    throw new Error(error || response.statusText);
  }
  return body as T;
}

export const now = () => Math.floor(Date.now() / 1000);

export function useFeeds(endpoint: Endpoint) {
  return useQuery({
    queryKey: ['feeds', endpoint],
    queryFn: () => get<FeedsResponse>('/api/feeds', { endpoint }),
    refetchInterval: REFRESH_MS,
  });
}

export function useHistory(feed: string, endpoint: Endpoint, range: Range) {
  return useQuery({
    queryKey: ['history', feed, endpoint, range],
    queryFn: () => {
      const to = now();
      const span = RANGES[range];
      return get<HistoryResponse>('/api/history', { feed, endpoint, from: span === null ? 0 : to - span, to });
    },
    placeholderData: keepPreviousData,
    refetchInterval: REFRESH_MS,
  });
}

// Conflicting values over a range. Counting them scans every record in the range, so they refresh every 5 minutes.
export function useConflicts(range: Range) {
  return useQuery({
    queryKey: ['conflicts', range],
    queryFn: () => {
      const to = now();
      const span = RANGES[range];
      return get<ConflictsResponse>('/api/conflicts', { from: span === null ? 0 : to - span, to });
    },
    placeholderData: keepPreviousData,
    refetchInterval: 5 * 60_000,
  });
}

// Prices at a chosen time, or the latest prices (refreshing) when no time is chosen.
export function useMoment(feed: string, endpoint: Endpoint, time: number | undefined) {
  return useQuery({
    queryKey: ['moment', feed, endpoint, time ?? 'latest'],
    queryFn: () => get<MomentResponse>('/api/at', { feed, endpoint, time: time ?? now() }),
    placeholderData: time === undefined ? keepPreviousData : undefined,
    refetchInterval: time === undefined ? REFRESH_MS : false,
  });
}

// The archive's airnodes and feeds, fetched once. It comes from the same server as this page's code, so it is trusted
// as far as the page itself is; what it rules out is a record relabelled as another provider or feed.
export function useCatalog() {
  return useQuery({
    queryKey: ['catalog'],
    queryFn: async () => createCatalog(await get<CatalogInput>('/api/catalog', {})),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export type SignatureCheck = 'valid' | 'wrong-source' | 'bad-signature';

// The server's word is not trusted. Each record is checked in the browser: its signer and template must be the
// feed's own (from the catalog), and the signature must recover to that signer. Checks wait for the catalog.
export function useSignatureChecks(
  catalog: Catalog | undefined,
  feed: string,
  endpoint: Endpoint,
  records: readonly SignedPrice[]
) {
  return useQueries({
    queries: records.map((record) => ({
      enabled: catalog !== undefined,
      queryKey: [
        'signature',
        feed,
        endpoint,
        record.provider,
        record.airnode,
        record.templateId,
        record.timestamp,
        record.encodedValue,
        record.signature,
      ],
      queryFn: async (): Promise<SignatureCheck> => {
        if (!catalog?.isFeedRecord(feed, endpoint, record)) return 'wrong-source';
        return (await hasValidSignature(record)) ? 'valid' : 'bad-signature';
      },
      staleTime: Number.POSITIVE_INFINITY,
    })),
  });
}
