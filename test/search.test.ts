import { describe, expect, test } from 'bun:test';
import { type FeedSearch, parseConflictsSearch, parseFeedSearch } from '../web/search.ts';

describe('parseFeedSearch', () => {
  test('keeps valid search params from a shared link', () => {
    expect(parseFeedSearch({ feed: 'BTC/USD', range: '7d', endpoint: 'public-oev', time: 1_793_206_910 })).toEqual({
      feed: 'BTC/USD',
      range: '7d',
      endpoint: 'public-oev',
      time: 1_793_206_910,
    });
  });

  test('falls back to defaults for anything unexpected', () => {
    const defaults: FeedSearch = { feed: 'ETH/USD', range: '24h', endpoint: 'public', time: undefined };
    expect(parseFeedSearch({})).toEqual(defaults);
    expect(parseFeedSearch({ feed: '', range: 'toString', endpoint: 'private', time: 1.5 })).toEqual(defaults);
    expect(parseFeedSearch({ feed: 42, range: 7, time: '1793206910' })).toEqual(defaults);
    expect(parseFeedSearch({ time: -5 })).toEqual(defaults);
  });
});

test('parseConflictsSearch keeps a known range and falls back to the last day', () => {
  expect(parseConflictsSearch({ range: '7d' })).toEqual({ range: '7d' });
  expect(parseConflictsSearch({ range: 'forever' })).toEqual({ range: '24h' });
  expect(parseConflictsSearch({})).toEqual({ range: '24h' });
});
