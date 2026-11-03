import { getRouteApi, Link } from '@tanstack/react-router';
import { type JSX, useId } from 'react';
import type { ConflictSummary } from '../../src/conflicts.ts';
import { useConflicts } from '../api.ts';
import { Segmented } from '../components/Segmented.tsx';
import { UpdatedAgo } from '../components/UpdatedAgo.tsx';
import { formatPrice, formatTime } from '../format.ts';
import { CONFLICT_RANGES } from '../search.ts';

const route = getRouteApi('/conflicts');
const ENDPOINT_LABELS: Record<string, string> = { public: 'Base', 'public-oev': 'OEV' };
// Which Signed APIs served the values of a conflicting moment.
const SOURCE_LABELS: Record<string, string> = {
  'api3+provider': "API3's and the provider's own",
  api3: "API3's only",
  provider: "Provider's own only",
};
const sourceLabel = (pairing: string) =>
  SOURCE_LABELS[pairing] ?? pairing.replaceAll('unknown', 'merged from another archive');
const formatSpread = (spread: number | null) => (spread === null ? 'undefined' : spread.toFixed(2));

export function ConflictsPage(): JSX.Element {
  const titleId = useId();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const conflicts = useConflicts(search.range);
  const summaries = conflicts.data?.summaries ?? [];

  return (
    <>
      <section className="intro">
        <h1>Two prices, one moment</h1>
        <p>
          Sometimes a provider signs two different prices for the same feed and the same second. Both signatures are
          genuine, so whoever pushes an update on-chain can choose which one counts. This page lists how often that
          happens, how far apart the prices were, and which Signed APIs served them.
        </p>
      </section>

      <section className="controls" aria-label="Choose a range">
        <Segmented
          label="Range"
          options={CONFLICT_RANGES}
          value={search.range}
          display={(range) => range.toUpperCase()}
          onChange={(range) => void navigate({ search: { range }, replace: true })}
        />
        {conflicts.data ? (
          <p className="muted">
            {summaries.length} provider feeds with conflicts · <UpdatedAgo at={conflicts.dataUpdatedAt} />
          </p>
        ) : null}
      </section>

      <section className="card" aria-labelledby={titleId}>
        <div className="card-head">
          <div>
            <h2 id={titleId}>By provider</h2>
            <p className="muted">
              Spread is the gap between the highest and lowest price signed for one moment, relative to their median, in
              basis points (1 bps = 0.01%). A zero median makes the spread undefined. The counts are a lower bound: each
              Signed API is polled about once a minute, so a conflict only shows when both are sampled at the same
              signed second.
            </p>
          </div>
        </div>
        {conflicts.error ? <p className="bad">{conflicts.error.message}</p> : null}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Data</th>
                <th className="num">Conflicts</th>
                <th className="num">Of moments</th>
                <th className="num">Rate</th>
                <th className="num">Median bps</th>
                <th className="num">90% bps</th>
                <th className="num">Widest bps</th>
                <th>Served by</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((summary) => (
                <tr key={`${summary.provider}-${summary.endpoint}`}>
                  <td>{summary.provider}</td>
                  <td>{ENDPOINT_LABELS[summary.endpoint] ?? summary.endpoint}</td>
                  <td className="num">{summary.conflicts.toLocaleString()}</td>
                  <td className="num">{summary.moments.toLocaleString()}</td>
                  <td className="num">{((100 * summary.conflicts) / summary.moments).toFixed(2)}%</td>
                  <td className="num">{formatSpread(summary.spreadBps.median)}</td>
                  <td className="num">{formatSpread(summary.spreadBps.p90)}</td>
                  <td className="num">{formatSpread(summary.spreadBps.max)}</td>
                  <td>
                    {Object.entries(summary.sources)
                      .map(([pairing, count]) => `${sourceLabel(pairing)} (${count.toLocaleString()})`)
                      .join(', ')}
                  </td>
                </tr>
              ))}
              {summaries.length === 0 ? (
                <tr>
                  <td colSpan={9} className="muted">
                    {conflicts.isPending ? 'Loading…' : 'No conflicting values in this range.'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {summaries.length > 0 ? <WidestConflicts summaries={summaries} /> : null}
    </>
  );
}

function WidestConflicts({ summaries }: { summaries: readonly ConflictSummary[] }) {
  const titleId = useId();
  return (
    <section className="card" aria-labelledby={titleId}>
      <div className="card-head">
        <div>
          <h2 id={titleId}>Widest conflict per provider</h2>
          <p className="muted">
            Open one to see both signed prices at that second, with each signature checked in your browser.
          </p>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Feed</th>
              <th>Signed at</th>
              <th className="num">Prices</th>
              <th className="num">Spread bps</th>
            </tr>
          </thead>
          <tbody>
            {summaries.map(({ provider, endpoint, widest }) => (
              <tr key={`${provider}-${endpoint}`}>
                <td>{provider}</td>
                <td>
                  <Link
                    to="/feed"
                    search={{
                      feed: widest.feed,
                      range: '24h',
                      endpoint: endpoint === 'public-oev' ? 'public-oev' : 'public',
                      time: widest.timestamp,
                    }}
                  >
                    {widest.feed}
                  </Link>{' '}
                  <span className="muted small">{ENDPOINT_LABELS[endpoint] ?? endpoint}</span>
                </td>
                <td>{formatTime(widest.timestamp)}</td>
                <td className="num">{widest.values.map((value) => formatPrice(value)).join(' vs ')}</td>
                <td className="num">{formatSpread(widest.spreadBps)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
