import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';
import type { ConflictsResponse, FeedsResponse, HistoryResponse, MomentResponse } from '../src/api.ts';
import { type Catalog, type CatalogInput, createCatalog } from '../src/catalog.ts';
import type { Endpoint } from '../src/config.ts';
import type { SignedPrice } from '../src/reader.ts';
import { hasValidSignature, toSignedDatum } from '../src/signed-data.ts';
import { type ConflictRange, RANGES, type Range } from './search.ts';

// The archiver adds records about once a minute; refreshing twice as often keeps live views at most half a cycle
// behind. TanStack Query pauses the refresh while the tab is hidden.
export const REFRESH_MS = 30_000;

async function get<T>(path: string, query: Record<string, string | number>): Promise<T> {
  const search = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
  const response = await fetch(`${path}?${search}`);
  if (!response.ok) {
    // An error from a proxy in front of the server may not be JSON; the status still says what went wrong.
    const body: unknown = await response.json().catch(() => null);
    const error = typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : '';
    throw new Error(error || `Request failed: HTTP ${response.status} ${response.statusText}`.trim());
  }
  return (await response.json()) as T;
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
export function useConflicts(range: ConflictRange) {
  return useQuery({
    queryKey: ['conflicts', range],
    queryFn: () => {
      const to = now();
      return get<ConflictsResponse>('/api/conflicts', { from: to - RANGES[range], to });
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

// The archive's current and historical mappings. It comes from the same server as this page's code, so it is trusted
// as far as the page itself is; what it rules out is a record relabelled as another provider or feed.
export function useCatalog() {
  return useQuery({
    queryKey: ['catalog'],
    queryFn: async () => createCatalog(await get<CatalogInput>('/api/catalog', {})),
    refetchInterval: REFRESH_MS,
  });
}

export type SignatureCheck = 'valid' | 'after-time' | 'wrong-source' | 'bad-signature';

// The server's word is not trusted. Each record is checked in the browser against the feed and time the user asked
// for, not the ones the server names: it must have the exact signed shape, be signed at or before `time` (when one is
// chosen), its signer and template must be the feed's own (from the catalog), and the signature must recover to that
// signer. A malformed record counts as a bad signature. Checks wait for the catalog.
export function useSignatureChecks(
  catalog: Catalog | undefined,
  feed: string,
  endpoint: Endpoint,
  time: number | undefined,
  records: readonly SignedPrice[]
) {
  return useQueries({
    queries: records.map((record) => ({
      enabled: catalog !== undefined,
      queryKey: [
        'signature',
        catalog?.input.revision,
        feed,
        endpoint,
        time ?? 'latest',
        record.provider,
        record.airnode,
        record.templateId,
        record.timestamp,
        record.encodedValue,
        record.signature,
      ],
      queryFn: async (): Promise<SignatureCheck> => {
        const datum = toSignedDatum(record);
        if (datum === null) return 'bad-signature';
        if (time !== undefined && Number(datum.timestamp) > time) return 'after-time';
        if (!catalog?.isFeedRecord(feed, endpoint, { ...datum, provider: record.provider })) return 'wrong-source';
        return (await hasValidSignature(datum)) ? 'valid' : 'bad-signature';
      },
      staleTime: Number.POSITIVE_INFINITY,
    })),
  });
}
