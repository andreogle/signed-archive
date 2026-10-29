import { type Hex, isAddressEqual } from 'viem';
import type { Catalog } from './catalog.ts';
import { decodeValue, formatPrice, median } from './price.ts';
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
  // (highest - lowest) / median value, in basis points, over the conflicting moments.
  spreadBps: { median: number; p90: number; max: number };
  // Which Signed APIs served the values of each conflicting moment: `api3+provider`, `api3`, `provider`, or with
  // `unknown` for records merged or repaired from another archive.
  sources: Record<string, number>;
  widest: { feed: string; timestamp: number; values: string[]; spreadBps: number };
}

type ConflictRecord = ReturnType<Reader['conflictRecords']>[number];

// Basis points, to two decimals, of `spread` relative to `base`; null when the base is zero.
const toBps = (spread: bigint, base: bigint) => {
  const magnitude = base < 0n ? -base : base;
  return magnitude === 0n ? null : Number((spread * 1_000_000n) / magnitude) / 100;
};

const percentile = (sorted: readonly number[], p: number) => {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
};

export function summarizeConflicts(reader: Reader, catalog: Catalog, from: number, to: number): ConflictSummary[] {
  const feedOf = new Map<string, string>();
  for (const [name, sources] of catalog.feeds) {
    for (const source of [...sources.public, ...sources['public-oev']])
      feedOf.set(source.templateId.toLowerCase(), name);
  }

  // One group per conflicting moment.
  const moments = new Map<string, ConflictRecord[]>();
  for (const record of reader.conflictRecords(from, to)) {
    const key = `${record.airnode}:${record.templateId}:${record.timestamp}`;
    moments.set(key, [...(moments.get(key) ?? []), record]);
  }

  const byTarget = new Map<
    string,
    { spreads: number[]; sources: Record<string, number>; widest: ConflictSummary['widest'] | null }
  >();
  for (const records of moments.values()) {
    const [first] = records;
    if (!first) continue;
    const values = records.map(({ value }) => decodeValue(value as Hex));
    const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const lowest = sorted[0] ?? 0n;
    const highest = sorted.at(-1) ?? 0n;
    const spread = toBps(highest - lowest, median(values) ?? 0n) ?? 0;
    const sources = [...new Set(records.map(({ source }) => source ?? 'unknown'))].sort().join('+');

    const key = `${first.airnode}:${first.endpoint}`;
    const target = byTarget.get(key) ?? { spreads: [], sources: {}, widest: null };
    target.spreads.push(spread);
    target.sources[sources] = (target.sources[sources] ?? 0) + 1;
    if (!target.widest || spread > target.widest.spreadBps) {
      const feed = feedOf.get(first.templateId.toLowerCase()) ?? first.templateId;
      target.widest = { feed, timestamp: first.timestamp, values: sorted.map(formatPrice), spreadBps: spread };
    }
    byTarget.set(key, target);
  }

  return reader
    .momentCounts(from, to)
    .flatMap(({ airnode, endpoint, moments: total }): ConflictSummary[] => {
      const target = byTarget.get(`${airnode}:${endpoint}`);
      if (!target?.widest) return [];
      const spreads = [...target.spreads].sort((a, b) => a - b);
      const provider = catalog.airnodes.find((entry) => isAddressEqual(entry.airnode, airnode))?.alias ?? airnode;
      return [
        {
          provider,
          endpoint,
          moments: total,
          conflicts: spreads.length,
          spreadBps: { median: percentile(spreads, 0.5), p90: percentile(spreads, 0.9), max: spreads.at(-1) ?? 0 },
          sources: target.sources,
          widest: target.widest,
        },
      ];
    })
    .sort((a, b) => b.conflicts - a.conflicts || a.provider.localeCompare(b.provider));
}

// A plain-text table for the terminal.
export function formatConflicts(summaries: readonly ConflictSummary[], from: number, to: number) {
  const range = `${new Date(from * 1000).toISOString()} to ${new Date(to * 1000).toISOString()}`;
  if (summaries.length === 0) return `No conflicting values between ${range}.\n`;
  const header = [
    'provider',
    'endpoint',
    'conflicts',
    'of moments',
    'rate',
    'median bps',
    'p90 bps',
    'max bps',
    'sources',
  ];
  const rows = summaries.map((s) => [
    s.provider,
    s.endpoint,
    String(s.conflicts),
    String(s.moments),
    `${((100 * s.conflicts) / s.moments).toFixed(2)}%`,
    s.spreadBps.median.toFixed(2),
    s.spreadBps.p90.toFixed(2),
    s.spreadBps.max.toFixed(2),
    Object.entries(s.sources)
      .map(([pairing, count]) => `${pairing} ${count}`)
      .join(', '),
  ]);
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)));
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd();
  const widest = summaries.map((s) => {
    const at = new Date(s.widest.timestamp * 1000).toISOString();
    return `  ${s.provider} ${s.endpoint}: ${s.widest.feed} at ${at}, ${s.widest.values.join(' vs ')} (${s.widest.spreadBps.toFixed(2)} bps)`;
  });
  return [
    `Conflicting values between ${range}:`,
    '',
    line(header),
    ...rows.map(line),
    '',
    'Widest conflict per provider:',
    ...widest,
    '',
  ].join('\n');
}
