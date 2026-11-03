import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Address } from 'viem';
import { backOff, poll, runArchiver, type Target } from '../src/archiver.ts';
import { createCatalog } from '../src/catalog.ts';
import { openReader } from '../src/reader.ts';
import { openStore } from '../src/store.ts';
import { blocksize, coingecko } from './fixtures.ts';

// A Signed API that answers each path with whatever the test sets for it, and counts requests.
const answers = new Map<string, () => Response>();
const requests: string[] = [];
const api = Bun.serve({
  port: 0,
  fetch: (request) => {
    const { pathname } = new URL(request.url);
    requests.push(pathname);
    return answers.get(pathname)?.() ?? new Response('not found', { status: 404 });
  },
});
const apiUrl = api.url.href.replace(/\/$/, '');

const dir = mkdtempSync(join(tmpdir(), 'signed-archive-archiver-'));
let stores = 0;
const freshStore = () => {
  stores += 1;
  const path = join(dir, `archive-${stores}.sqlite`);
  return { path, store: openStore(path) };
};

const target = (airnode: Address): Target => {
  return {
    alias: 'coingecko',
    airnode,
    endpoint: 'public',
    source: 'api3',
    baseUrl: apiUrl,
    failures: 0,
    retryAt: 0,
    feeds: null,
  };
};
const path = `/public/${coingecko.airnode}`;
const stop = new AbortController().signal;

let stderr: ReturnType<typeof spyOn>;
beforeAll(() => {
  stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterAll(() => {
  stderr.mockRestore();
  void api.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe('poll', () => {
  test('a bad signature or wrong signer cannot hide a genuine record later in the response', async () => {
    const badSignature = { ...coingecko, signature: `0x${'00'.repeat(65)}` };
    const wrongSigner = { ...coingecko, airnode: blocksize[0]?.airnode };
    for (const bad of [badSignature, wrongSigner]) {
      answers.set(path, () => Response.json({ data: { bad, good: coingecko, repeated: bad } }));
      const { store } = freshStore();
      try {
        expect(await poll(target(coingecko.airnode), store, 60_000, stop)).toEqual({ saved: 1, rejected: 1 });
        expect(store.has(coingecko)).toBe(true);
      } finally {
        store.close();
      }
    }
  });

  test('saves genuine records of the polled airnode, rejects the rest, and checks each duplicate once', async () => {
    const forged = { ...coingecko, encodedValue: `0x${'00'.repeat(31)}01` };
    answers.set(path, () => {
      return Response.json({ data: { a: coingecko, b: coingecko, c: forged, d: blocksize[0], e: 'junk' } });
    });
    const { path: dbPath, store } = freshStore();
    expect(await poll(target(coingecko.airnode), store, 60_000, stop)).toEqual({ saved: 1, rejected: 3 });
    store.close();
    const reader = openReader(dbPath);
    expect(reader.records([{ provider: 'coingecko', ...coingecko }], 0, 2e9)).toHaveLength(1);
    reader.close();
  });

  test('records a failed request as a poll with its status, and backs off as long as Retry-After asks', async () => {
    const retryAt = new Date(Date.now() + 120_000).toUTCString();
    answers.set(path, () => new Response('busy', { status: 503, headers: { 'retry-after': retryAt } }));
    const { path: dbPath, store } = freshStore();
    const polled = target(coingecko.airnode);
    expect(await poll(polled, store, 60_000, stop)).toBeNull();
    store.close();
    expect(polled.failures).toBe(1);
    // An HTTP date is honoured like a number of seconds: about two minutes, not the one-minute exponential default.
    expect(polled.retryAt - performance.now()).toBeGreaterThan(100_000);
    const db = new Database(dbPath, { readonly: true });
    expect(db.query('SELECT status, saved, source FROM polls').all()).toEqual([
      { status: 503, saved: 0, source: 'api3' },
    ]);
    db.close();
  });

  test('refuses an oversized body, and a response without a data object', async () => {
    const { store } = freshStore();
    answers.set(path, () => new Response(`{"data":{},"pad":"${'x'.repeat(17 * 1024 * 1024)}"}`));
    await expect(poll(target(coingecko.airnode), store, 60_000, stop)).rejects.toThrow('response over');
    answers.set(path, () => Response.json({ count: 0 }));
    await expect(poll(target(coingecko.airnode), store, 60_000, stop)).rejects.toThrow('no data object');
    store.close();
  });
});

describe('backOff', () => {
  test('doubles with each failure, never waits past 30 minutes, and reads Retry-After in seconds', () => {
    const backingOff = target(coingecko.airnode);
    expect(backOff(backingOff, 60_000, null)).toBe(120);
    expect(backOff(backingOff, 60_000, null)).toBe(240);
    backingOff.failures = 20;
    expect(backOff(backingOff, 60_000, null)).toBe(1800);
    expect(backOff(backingOff, 60_000, '90')).toBe(90);
    expect(backOff(backingOff, 60_000, 'soon')).toBe(1800);
  });
});

describe('runArchiver', () => {
  test('does not start when its stop signal is already aborted', async () => {
    const before = requests.length;
    await runArchiver({
      intervalSeconds: 60,
      dbPath: join(dir, 'cancelled.sqlite'),
      catalog: createCatalog({ airnodes: [], feeds: {} }),
      api3Url: apiUrl,
      signal: AbortSignal.abort(),
    });
    expect(requests).toHaveLength(before);
    expect(await Bun.file(join(dir, 'cancelled.sqlite')).exists()).toBe(false);
  });

  test('polls every target in turn, records failures without stopping, and stops when asked', async () => {
    const listeners = ['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name));
    requests.length = 0;
    answers.set(path, () => Response.json({ data: { a: coingecko } }));
    const catalog = createCatalog({
      airnodes: [{ alias: 'coingecko', airnode: coingecko.airnode, signedApiUrl: 'http://127.0.0.1:1' }],
      feeds: {},
    });
    const dbPath = join(dir, 'running.sqlite');
    const stopping = new AbortController();
    setTimeout(() => stopping.abort(), 600);
    await runArchiver({ intervalSeconds: 0.4, dbPath, catalog, api3Url: apiUrl, signal: stopping.signal });
    // API3's host answered; the provider's own host is unreachable and backs off after its first failure.
    expect(requests).toContain(path);
    expect(requests).toContain(`/public-oev/${coingecko.airnode}`);
    const reader = openReader(dbPath);
    expect(reader.records([{ provider: 'coingecko', ...coingecko }], 0, 2e9)).toHaveLength(1);
    reader.close();
    expect(['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name))).toEqual(listeners);
  });
});
