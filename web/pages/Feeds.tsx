import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { now, useFeeds } from '../api.ts';
import { formatAge, formatPrice } from '../format.ts';

export function FeedsPage() {
  const [filter, setFilter] = useState('');
  const { data, error, isPending } = useFeeds('public');
  const needle = filter.trim().toUpperCase();
  const feeds = data?.feeds.filter(({ feed }) => feed.includes(needle)) ?? [];

  return (
    <>
      <section className="intro">
        <h1>API3 prices, signed and kept</h1>
        <p>
          API3's Signed API only shows the latest price. This archive keeps every signed record, so you can see what any
          feed said at any moment, and check the provider's signature yourself.
        </p>
      </section>

      <section className="controls" aria-label="Filter feeds">
        <label className="field">
          <span>Search</span>
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="ETH, BTC, USDC…"
            spellCheck={false}
          />
        </label>
        {data ? <p className="muted">{data.feeds.length} feeds archived</p> : null}
      </section>

      {isPending ? <p className="muted">Loading feeds…</p> : null}
      {error ? <p className="bad">Could not load feeds: {error.message}</p> : null}
      {data && feeds.length === 0 ? <p className="muted">No archived feed matches “{filter}”.</p> : null}

      <ul className="feed-grid">
        {feeds.map(({ feed, providers, latest, median }) => (
          <li key={feed}>
            <Link className="feed-card" to="/feed" search={{ feed, range: '24h', endpoint: 'public' }}>
              <span className="feed-name">{feed}</span>
              <span className="big">{median === null ? '—' : formatPrice(median)}</span>
              <span className="muted small">
                {providers} providers · signed {formatAge(Math.max(0, now() - latest))} ago
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
