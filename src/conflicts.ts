import type { Hex } from 'viem';
import type { Catalog } from './catalog.ts';
import { decodeValue, formatPrice, spreadBps } from './price.ts';
import type { Reader } from './reader.ts';

// Moments when a provider signed more than one value for the same feed and second. Each value is genuine (the archive
// only keeps verified records), so whoever updates on-chain can choose between them. This summarises how often that
// happens per provider and endpoint, how far apart the values are, and which Signed APIs served them.

export interface ConflictSummary {
  provider: string;
  endpoint: string;
  // Distinct signed moments (feed and second) in the range, and how many of them had more than one value.
  moments: number;
  conflicts: number;
  // (highest - lowest) / absolute median, in basis points. Null means a zero median; ranked above finite spreads.
  spreadBps: { median: number | null; p90: number | null; max: number | null };
  // Which Signed APIs served the values of each conflicting moment: `api3+provider`, `api3`, `provider`, or with
  // `unknown` for records merged or repaired from another archive.
  sources: Record<string, number>;
  widest: { feed: string; timestamp: number; values: string[]; spreadBps: number | null };
}

type ConflictRecord = Awaited<ReturnType<Reader['conflictRecords']>>[number];

const percentile = (sorted: readonly (number | null)[], p: number) => {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? null;
};

export async function summarizeConflicts(
  reader: Reader,
  catalog: Catalog,
  from: number,
  to: number
): Promise<ConflictSummary[]> {
  const feedOf = new Map<string, string>();
  const sources = [...catalog.feeds].flatMap(([name, feed]) => {
    const all = [...feed.public, ...feed['public-oev']];
    for (const source of all) feedOf.set(source.templateId.toLowerCase(), name);
    return all;
  });

  // One group per conflicting moment.
  const moments = new Map<string, ConflictRecord[]>();
  for (const record of await reader.conflictRecords(sources, from, to)) {
    const key = `${record.airnode}:${record.templateId}:${record.timestamp}`;
    moments.set(key, [...(moments.get(key) ?? []), record]);
  }

  const byTarget = new Map<
    string,
    { spreads: (number | null)[]; sources: Record<string, number>; widest: ConflictSummary['widest'] | null }
  >();
  for (const records of moments.values()) {
    const [first] = records;
    if (!first) continue;
    const values = records.map(({ value }) => decodeValue(value as Hex));
    const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const spread = spreadBps(values);
    const sources = [...new Set(records.map(({ source }) => source ?? 'unknown'))].sort().join('+');

    const key = `${first.airnode}:${first.endpoint}`;
    const target = byTarget.get(key) ?? { spreads: [], sources: {}, widest: null };
    target.spreads.push(spread);
    target.sources[sources] = (target.sources[sources] ?? 0) + 1;
    if (
      !target.widest ||
      (spread ?? Number.POSITIVE_INFINITY) > (target.widest.spreadBps ?? Number.POSITIVE_INFINITY)
    ) {
      const feed = feedOf.get(first.templateId.toLowerCase()) ?? first.templateId;
      target.widest = { feed, timestamp: first.timestamp, values: sorted.map(formatPrice), spreadBps: spread };
    }
    byTarget.set(key, target);
  }

  return (await reader.momentCounts(sources, from, to))
    .flatMap(({ airnode, endpoint, moments: total }): ConflictSummary[] => {
      const target = byTarget.get(`${airnode}:${endpoint}`);
      if (!target?.widest) return [];
      const spreads = [...target.spreads].sort(
        (a, b) => (a ?? Number.POSITIVE_INFINITY) - (b ?? Number.POSITIVE_INFINITY)
      );
      const provider = catalog.aliasOf(airnode) ?? airnode;
      return [
        {
          provider,
          endpoint,
          moments: total,
          conflicts: spreads.length,
          spreadBps: { median: percentile(spreads, 0.5), p90: percentile(spreads, 0.9), max: spreads.at(-1) ?? null },
          sources: target.sources,
          widest: target.widest,
        },
      ];
    })
    .sort((a, b) => b.conflicts - a.conflicts || a.provider.localeCompare(b.provider));
}
