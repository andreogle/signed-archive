import { afterAll, describe, expect, test } from 'bun:test';
import { handleApi } from '../src/api.ts';
import { openReader } from '../src/reader.ts';
import { fixtureDb } from './fixtures.ts';

const db = fixtureDb();
const reader = openReader(db.path);
const now = 1_793_207_000;
const get = async (path: string) => {
  const response = handleApi(reader, new URL(path, 'http://localhost'), now);
  return { status: response.status, body: await response.json() };
};

afterAll(() => {
  reader.close();
  db.remove();
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
    expect(body).toMatchObject({ from: now - 86_400, to: now, earliest: 1_793_206_903, gaps: [] });
    expect(body.providers.map(({ provider, slot }: { provider: string; slot: number }) => [provider, slot])).toEqual([
      ['blocksize', 0],
      ['coingecko', 1],
      ['coinmetrics', 2],
    ]);
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
