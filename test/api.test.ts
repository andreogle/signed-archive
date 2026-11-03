import { afterAll, describe, expect, test } from 'bun:test';
import { handleApi } from '../src/api.ts';
import { openReader } from '../src/reader.ts';
import { openStore } from '../src/store.ts';
import { catalog, coinmetrics, fixtureDb } from './fixtures.ts';

const db = fixtureDb();
const reader = openReader(db.path);
const now = 1_793_207_000;
const get = async (path: string) => {
  const response = await handleApi(reader, catalog, new URL(path, 'http://localhost'), now);
  return { status: response.status, body: await response.json() };
};

afterAll(() => {
  reader.close();
  db.remove();
});

describe('GET /api/catalog', () => {
  test('returns the configured airnodes and feeds, so the web app checks against the same lists', async () => {
    const body = await (await handleApi(reader, catalog, new URL('http://localhost/api/catalog'), 0)).json();
    expect(body).toEqual(catalog.input);
  });
});

describe('/api/feeds', () => {
  test('lists only feeds with archived records, per endpoint', async () => {
    expect((await get('/api/feeds')).body.feeds).toEqual([
      { feed: 'ETH/USD', providers: 3, latest: 1_793_206_951, median: '2332.2122749432156' },
    ]);
    expect((await get('/api/feeds?endpoint=public-oev')).body.feeds).toEqual([
      { feed: 'ETH/USD', providers: 1, latest: 1_793_206_922, median: '2332.22' },
    ]);
  });
});

describe('/api/at', () => {
  test('returns the signed records and their median', async () => {
    const { status, body } = await get('/api/at?feed=ETH/USD&time=1793206960');
    expect(status).toBe(200);
    expect(body.records).toHaveLength(3);
    expect(body.median).toBe('2332.2122749432156');
  });

  test('returns a null median when nothing was signed yet', async () => {
    expect((await get('/api/at?feed=ETH/USD&time=1')).body).toMatchObject({ median: null, records: [] });
  });
});

describe('/api/history', () => {
  test('defaults to the last 24 hours', async () => {
    const { body } = await get('/api/history?feed=ETH/USD');
    // The archive starts within the last day, so the range starts at its first record.
    expect(body).toMatchObject({ from: 1_793_206_903, to: now, earliest: 1_793_206_903, gaps: [] });
    expect(body.providers.map(({ provider, slot }: { provider: string; slot: number }) => [provider, slot])).toEqual([
      ['blocksize', 0],
      ['coingecko', 1],
      ['coinmetrics', 2],
    ]);
  });
});

describe('/api/history?from=0', () => {
  test('starts at the first record, so the whole range keeps its detail', async () => {
    const { body } = await get('/api/history?feed=ETH/USD&from=0');
    expect(body.from).toBe(1_793_206_903);
    expect(body.providers[0].points).toHaveLength(2);
  });
});

describe('a provider that signed two values for one moment', () => {
  const local = fixtureDb();
  const store = openStore(local.path);
  store.add(
    [{ datum: { ...coinmetrics, encodedValue: `0x${'00'.repeat(31)}01` }, endpoint: 'public', fetchedAt: 1 }],
    []
  );
  store.close();
  const conflicted = openReader(local.path);

  afterAll(() => {
    conflicted.close();
    local.remove();
  });

  test('shows both records, but gives the provider one vote and counts it once', async () => {
    const at = await handleApi(
      conflicted,
      catalog,
      new URL('http://localhost/api/at?feed=ETH/USD&time=1793206960'),
      now
    );
    const body = await at.json();
    expect(body.records.filter(({ provider }: { provider: string }) => provider === 'coinmetrics')).toHaveLength(2);
    expect(body.median).toBe('2332.2122749432156');
    const feeds = await (await handleApi(conflicted, catalog, new URL('http://localhost/api/feeds'), now)).json();
    expect(feeds.feeds[0].providers).toBe(3);
  });
});

describe('bad input', () => {
  test('rejects unknown feeds, endpoints, paths and malformed times', async () => {
    expect((await get('/api/at?feed=NOPE/USD')).status).toBe(404);
    expect((await get('/api/at?feed=ETH/USD&endpoint=private')).status).toBe(400);
    expect((await get('/api/at?feed=ETH/USD&time=-1')).status).toBe(400);
    expect((await get('/api/history?feed=ETH/USD&from=5&to=4')).status).toBe(400);
    expect((await get('/api/history?feed=ETH/USD&to=soon')).status).toBe(400);
    expect((await get('/api/nope?feed=ETH/USD')).status).toBe(404);
  });
});
