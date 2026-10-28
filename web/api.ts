import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';
import type { FeedsResponse, HistoryResponse, MomentResponse } from '../src/api.ts';
import type { Endpoint } from '../src/config.ts';
import { isFeedRecord } from '../src/feeds.ts';
import type { SignedPrice } from '../src/reader.ts';
import { hasValidSignature } from '../src/signed-data.ts';
import { RANGES, type Range } from './search.ts';

// The archiver adds records every cycle, so live views refresh about as often.
const REFRESH_MS = 60_000;

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

export function useMoment(feed: string, endpoint: Endpoint, time: number | undefined) {
  return useQuery({
    queryKey: ['moment', feed, endpoint, time],
    queryFn: () => get<MomentResponse>('/api/at', { feed, endpoint, time: time ?? now() }),
    enabled: time !== undefined,
  });
}

export type SignatureCheck = 'valid' | 'wrong-source' | 'bad-signature';

// The server's word is not trusted. Each record is checked in the browser: its signer and template must be the
// feed's own (from API3's provider list, bundled into the page), and the signature must recover to that signer.
export function useSignatureChecks(feed: string, endpoint: Endpoint, records: readonly SignedPrice[]) {
  return useQueries({
    queries: records.map((record) => ({
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
        if (!isFeedRecord(feed, endpoint, record)) return 'wrong-source';
        return (await hasValidSignature(record)) ? 'valid' : 'bad-signature';
      },
      staleTime: Number.POSITIVE_INFINITY,
    })),
  });
}
