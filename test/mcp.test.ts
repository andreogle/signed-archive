import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { handleMcp, handleMcpHttp, runMcpStdio } from '../src/mcp.ts';
import { openReader } from '../src/reader.ts';
import { openStore } from '../src/store.ts';
import { catalog, coingecko, fixtureDb, zecConflict } from './fixtures.ts';

// Real ETH/USD records signed 1793206903-1793206951 by blocksize, coingecko and coinmetrics; one coingecko OEV record.
const db = fixtureDb();
const reader = openReader(db.path);
const now = 1_793_207_000;

afterAll(() => {
  reader.close();
  db.remove();
});

// `id: null` sends a notification, which has no id at all.
const rpc = (method: string, params?: Record<string, unknown>, id: number | null = 1) => {
  return handleMcp(reader, catalog, { jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }, now);
};
// biome-ignore lint/suspicious/noExplicitAny: tool results are free-form JSON, inspected field by field below
const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
  const response = await rpc('tools/call', { name, arguments: args });
  if (!response || !('result' in response)) throw new Error('expected a result');
  return response.result;
};

describe('protocol', () => {
  test('initializes with the requested protocol version, or the newest it knows', async () => {
    const known = await rpc('initialize', { protocolVersion: '2025-03-26' });
    expect(known).toMatchObject({ result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } } });
    const unknown = await rpc('initialize', { protocolVersion: '1999-01-01' });
    expect(unknown).toMatchObject({ result: { protocolVersion: '2025-06-18' } });
  });

  test('lists five read-only tools, each with an input schema', async () => {
    const response = await rpc('tools/list');
    const tools =
      response && 'result' in response ? (response.result as { tools: Record<string, unknown>[] }).tools : [];
    expect(tools.map(({ name }) => name)).toEqual([
      'list_feeds',
      'get_price_at',
      'check_price',
      'get_price_history',
      'get_conflicts',
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    }
  });

  test('answers ping, ignores notifications, and reports unknown methods and malformed messages', async () => {
    expect(await rpc('ping')).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(await rpc('notifications/initialized', undefined, null)).toBeNull();
    expect(await rpc('resources/list')).toMatchObject({ error: { code: -32601 } });
    expect(await handleMcp(reader, catalog, [{ jsonrpc: '2.0', id: 1, method: 'ping' }])).toMatchObject({
      error: { code: -32600 },
    });
    expect(await handleMcp(reader, catalog, { id: 1, method: 'ping' })).toMatchObject({ error: { code: -32600 } });
  });
});

describe('logs', () => {
  test('logs who connected and every tool call, with refused arguments apart from failures', async () => {
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '2.1.0' } });
    await call('get_price_at', { feed: 'ETH/USD', time: now });
    await call('get_price_at', { feed: 'NOPE/USD', time: now });
    const lines = stderr.mock.calls.map(([line]) => String(line));
    stderr.mockRestore();
    expect(lines[0]).toContain(
      '[info] mcp client connected client=claude-code version=2.1.0 protocolVersion=2025-06-18'
    );
    expect(lines[1]).toMatch(/\[info\] mcp tool called tool=get_price_at feed=ETH\/USD durationMs=\d+$/m);
    expect(lines[2]).toMatch(
      /\[info\] mcp tool refused tool=get_price_at feed=NOPE\/USD durationMs=\d+ error="unknown feed/
    );
  });
});

describe('tools', () => {
  test("get_price_at returns each provider's signed record, verified, with its age and the median", async () => {
    const result = await call('get_price_at', { feed: 'ETH/USD', time: '2026-10-28T19:48:30Z' });
    const { structuredContent: body } = result;
    expect(body.providers).toBe(3);
    expect(body.records.map(({ provider }: { provider: string }) => provider)).toEqual([
      'blocksize',
      'coingecko',
      'coinmetrics',
    ]);
    const record = body.records.find(({ provider }: { provider: string }) => provider === 'coingecko');
    expect(record).toMatchObject({ verified: true, conflicting: false, signed: { signature: coingecko.signature } });
    expect(record.ageSeconds).toBe(Date.parse('2026-10-28T19:48:30Z') / 1000 - Number(coingecko.timestamp));
    expect(body.median).toBe('2332.2122749432156');
    // The text content is the same JSON, for clients that only read text.
    expect(JSON.parse(result.content[0].text)).toEqual(body);
    // Unix seconds work too; before any record there is nothing.
    expect((await call('get_price_at', { feed: 'ETH/USD', time: 1 })).structuredContent).toMatchObject({
      records: [],
      median: null,
    });
  });

  test('check_price passes fresh agreeing prices and names stale ones', async () => {
    const fresh = (await call('check_price', { feed: 'ETH/USD', maxAgeSeconds: 120 })).structuredContent;
    expect(fresh).toMatchObject({ verdict: 'ok', issues: [], providers: 3 });
    const strict = (await call('check_price', { feed: 'ETH/USD', maxAgeSeconds: 60, maxSpreadBps: 1 }))
      .structuredContent;
    expect(strict.verdict).toBe('warn');
    // Signed 93 s and 88 s before now; blocksize, at 49 s, is fresh enough.
    expect(strict.issues.join(' ')).toContain('stale (older than 60 s): coingecko, coinmetrics');
    expect(strict.issues.join(' ')).toContain('providers disagree by');
    // One OEV provider is worth a warning on its own.
    const oev = (await call('check_price', { feed: 'ETH/USD', endpoint: 'public-oev' })).structuredContent;
    expect(oev.issues).toContain('only one provider signed a price');
  });

  test('list_feeds, get_price_history and get_conflicts answer from the archive', async () => {
    const feeds = (await call('list_feeds', { search: 'eth' })).structuredContent;
    expect(feeds.feeds.map(({ feed }: { feed: string }) => feed)).toEqual(['ETH/USD']);
    const history = (await call('get_price_history', { feed: 'ETH/USD', from: 0, to: now, points: 1 }))
      .structuredContent;
    for (const { points } of history.providers) expect(points).toHaveLength(1);
    const conflicts = (await call('get_conflicts', {})).structuredContent;
    expect(conflicts.summaries).toEqual([]);
  });

  test('reports bad arguments as tool errors the agent can read', async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['get_price_at', { feed: 'NOPE/USD', time: 1 }, 'unknown feed NOPE/USD'],
      ['get_price_at', { time: 1 }, 'feed is required'],
      ['get_price_at', { feed: 'ETH/USD', time: 'yesterday-ish' }, 'time must be an ISO 8601 time'],
      ['get_price_at', { feed: 'ETH/USD', time: 1, endpoint: 'private' }, 'endpoint must be one of'],
      ['check_price', { feed: 'ETH/USD', maxAgeSeconds: -5 }, 'maxAgeSeconds must be a positive number'],
      ['get_price_history', { feed: 'ETH/USD', from: 10, to: 5 }, 'from must not be after to'],
      ['get_conflicts', { from: 10, to: 5 }, 'from must not be after to'],
      ['launch_rockets', {}, 'unknown tool launch_rockets'],
    ];
    for (const [name, args, message] of cases) {
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(message);
    }
  });
});

describe('POST /mcp', () => {
  const post = (body: string, method = 'POST') => {
    return handleMcpHttp(
      reader,
      catalog,
      new Request('http://x/mcp', { method, body: method === 'POST' ? body : null })
    );
  };

  test('answers a request as JSON, a notification with 202, and refuses other methods and bad JSON', async () => {
    const answer = await post(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }));
    expect(await answer.json()).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
    expect((await post(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status).toBe(202);
    expect((await post('', 'GET')).status).toBe(405);
    expect((await post('{not json')).status).toBe(400);
  });
});

describe('stdio', () => {
  test('answers one JSON message per line, skips blank lines and notifications, and survives bad JSON', async () => {
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      '',
      '{broken',
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    ];
    const written: string[] = [];
    await runMcpStdio(reader, catalog, Readable.from(lines.map((line) => `${line}\n`)), {
      write: (text) => written.push(text),
    });
    const answers = written.map((text) => JSON.parse(text));
    expect(answers.map((answer) => answer.id ?? answer.error?.code)).toEqual([1, -32700, 2]);
    for (const text of written) expect(text.endsWith('\n')).toBe(true);
  });
});

describe('get_conflicts with a real conflict', () => {
  test('reports the provider, the spread and when the widest conflict was signed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'signed-archive-mcp-'));
    const path = join(dir, 'archive.sqlite');
    const store = openStore(path);
    const [fromApi3, fromProvider] = zecConflict;
    const poll = { airnode: fromApi3.airnode, endpoint: 'public', status: 200, received: 1, rejected: 0 } as const;
    store.save([fromApi3], { ...poll, source: 'api3', fetchedAt: 1_793_219_975_396 });
    store.save([fromProvider], { ...poll, source: 'provider', fetchedAt: 1_793_219_977_006 });
    store.close();
    const conflictReader = openReader(path);
    const response = await handleMcp(
      conflictReader,
      catalog,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_conflicts', arguments: { from: 0 } } },
      1_793_300_000
    );
    conflictReader.close();
    rmSync(dir, { recursive: true, force: true });
    const body =
      response && 'result' in response ? (response.result as { structuredContent: { summaries: unknown[] } }) : null;
    expect(body?.structuredContent.summaries).toMatchObject([
      { provider: 'blocksize', conflicts: 1, widest: { feed: 'ZEC/USD', signedAt: '2026-10-28T20:39:16.000Z' } },
    ]);
  });
});
