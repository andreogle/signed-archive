import { createInterface } from 'node:readline';
import pkg from '../package.json' with { type: 'json' };
import { MAX_CONFLICT_SECONDS } from './api.ts';
import type { Catalog, FeedSource } from './catalog.ts';
import { ENDPOINTS, type Endpoint, isEndpoint } from './config.ts';
import { summarizeConflicts } from './conflicts.ts';
import { errorMessage, log } from './logger.ts';
import { decodeValue, medianPrice, spreadBps } from './price.ts';
import type { Reader, SignedPrice } from './reader.ts';
import { hasValidSignature } from './signed-data.ts';

// A Model Context Protocol server, so AI agents can ask the archive for signed prices at past moments with the proof
// attached. It answers JSON-RPC 2.0 messages; `runMcpStdio` serves them over stdin and stdout (one message per line)
// for local agents, and the explorer serves the same handler at POST /mcp for remote ones. All tools are read-only.

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_HISTORY_POINTS = 200;
const DEFAULT_HISTORY_POINTS = 60;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };

// A tool argument that is wrong is the caller's mistake, reported as a tool error the agent can read and correct.
class ArgumentError extends Error {}
// A tool that doesn't exist is a protocol error (-32602), as MCP specifies.
class UnknownTool extends Error {}

const endpointSchema = {
  type: 'string',
  enum: [...ENDPOINTS],
  description: "'public' (base feed data, delayed ~15 s) or 'public-oev' (fresher, signed for OEV auctions).",
};
const timeSchema = {
  type: ['string', 'number'],
  description: 'An ISO 8601 time with a zone, such as 2026-10-29T22:30:00Z, a date (UTC midnight), or unix seconds.',
};
const feedSchema = { type: 'string', description: "A feed name such as 'ETH/USD'; see list_feeds." };

const TOOLS = [
  {
    name: 'list_feeds',
    title: 'List feeds',
    description:
      "Feeds this archive holds signed prices for, with each one's current median price and how many providers sign it.",
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: "Only feeds whose name contains this, e.g. 'ETH'." },
        endpoint: endpointSchema,
      },
    },
  },
  {
    name: 'get_price_at',
    title: 'Signed prices at a moment',
    description:
      "Every provider's latest signed price at or before a moment, with the median, each record's age, and the raw " +
      'signed fields so the result can be verified independently: the signature is EIP-191 over ' +
      'keccak256(abi.encodePacked(templateId, timestamp, encodedValue)) and must recover to airnode.',
    inputSchema: {
      type: 'object',
      properties: { feed: feedSchema, time: timeSchema, endpoint: endpointSchema },
      required: ['feed', 'time'],
    },
  },
  {
    name: 'check_price',
    title: 'Is this price safe to use?',
    description:
      'Checks the latest signed prices of a feed: are they fresh, do the providers agree, and did any provider sign ' +
      'two values for one moment. Returns a verdict, the issues found, and the records checked with their raw signed ' +
      'fields.',
    inputSchema: {
      type: 'object',
      properties: {
        feed: feedSchema,
        endpoint: endpointSchema,
        maxAgeSeconds: { type: 'number', description: 'Oldest acceptable record, in seconds. Default 300.' },
        maxSpreadBps: {
          type: 'number',
          description: 'Widest acceptable gap between the highest and lowest provider, in basis points. Default 100.',
        },
      },
      required: ['feed'],
    },
  },
  {
    name: 'get_price_history',
    title: 'Price history',
    description:
      "Each provider's price over a time range, downsampled to at most `points` per provider, and the stretches when " +
      'the archive has no data (missing points there are unknown, not unchanged).',
    inputSchema: {
      type: 'object',
      properties: {
        feed: feedSchema,
        from: timeSchema,
        to: timeSchema,
        endpoint: endpointSchema,
        points: { type: 'number', description: `Points per provider, at most ${MAX_HISTORY_POINTS}. Default 60.` },
      },
      required: ['feed', 'from', 'to'],
    },
  },
  {
    name: 'get_conflicts',
    title: 'Conflicting signed values',
    description:
      'Moments when a provider signed more than one value for the same feed and second, per provider: how often, how ' +
      'far apart the values were in basis points, and the widest example. Whoever updates on-chain can choose between ' +
      'such values. Counts are a lower bound, since the archive samples each provider about once a minute. The range ' +
      'is at most 7 days, the last day by default. Re-check the widest example with get_price_at at its second: both ' +
      'signed values come back with their raw fields.',
    inputSchema: { type: 'object', properties: { from: timeSchema, to: timeSchema } },
  },
].map((tool) => ({ ...tool, annotations: { readOnlyHint: true, openWorldHint: false } }));

// Unix seconds above this are almost certainly milliseconds (it is the year 5138).
const MAX_SECONDS = 1e11;
// A date, or a date and time with a zone. A time without one would be read in the server's own zone.
const ISO_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

// Unix seconds from an ISO 8601 string or a number of seconds.
function parseTime(value: unknown, name: string): number {
  const seconds = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
    if (seconds >= MAX_SECONDS) throw new ArgumentError(`${name} must be unix seconds, not milliseconds`);
    return Math.floor(seconds);
  }
  const parsed = typeof value === 'string' && ISO_TIME.test(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isNaN(parsed) && typeof value === 'string') {
    // Date.parse normalizes impossible dates such as February 30 into the next month.
    const date = value.slice(0, 10);
    if (new Date(`${date}T00:00:00Z`).toISOString().startsWith(date)) return Math.floor(parsed / 1000);
  }
  throw new ArgumentError(`${name} must be an ISO 8601 time with a zone (e.g. 2026-10-29T22:30:00Z) or unix seconds`);
}

const readEndpoint = (value: unknown): Endpoint => {
  if (value === undefined) return 'public';
  if (isEndpoint(value)) return value;
  throw new ArgumentError(`endpoint must be one of ${ENDPOINTS.join(', ')}`);
};

const readNumber = (value: unknown, name: string, fallback: number, max = Number.POSITIVE_INFINITY) => {
  if (value === undefined) return fallback;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.min(value, max);
  throw new ArgumentError(`${name} must be a positive number`);
};

const readCount = (value: unknown, name: string, fallback: number, max: number) => {
  if (value === undefined) return fallback;
  if (Number.isSafeInteger(value) && (value as number) >= 1) return Math.min(value as number, max);
  throw new ArgumentError(`${name} must be a whole number of at least 1`);
};

function sourcesOf(catalog: Catalog, feed: unknown, endpoint: Endpoint): FeedSource[] {
  if (typeof feed !== 'string' || feed === '') throw new ArgumentError('feed is required, e.g. "ETH/USD"');
  const sources = catalog.feeds.get(feed)?.[endpoint];
  if (!sources) throw new ArgumentError(`unknown feed ${feed}; list_feeds shows the feeds this archive holds`);
  return sources;
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

// The records of a moment as an agent should see them: price decoded, signature and feed membership checked by this
// server, age, and whether the provider signed another value for the same moment.
async function describeRecords(catalog: Catalog, feed: string, endpoint: Endpoint, records: SignedPrice[], at: number) {
  const providers = records.map(({ provider }) => provider);
  return Promise.all(
    records.map(async (record) => {
      const verified = catalog.isFeedRecord(feed, endpoint, record) && (await hasValidSignature(record));
      return {
        provider: record.provider,
        price: record.price,
        signedAt: iso(Number(record.timestamp)),
        ageSeconds: at - Number(record.timestamp),
        verified,
        conflicting: providers.filter((provider) => provider === record.provider).length > 1,
        signed: {
          airnode: record.airnode,
          templateId: record.templateId,
          timestamp: record.timestamp,
          encodedValue: record.encodedValue,
          signature: record.signature,
        },
      };
    })
  );
}

type ToolArguments = Record<string, unknown>;

async function callTool(reader: Reader, catalog: Catalog, name: string, args: ToolArguments, now: number) {
  switch (name) {
    case 'list_feeds': {
      const endpoint = readEndpoint(args.endpoint);
      const needle = typeof args.search === 'string' ? args.search.toUpperCase() : '';
      const matching = [...catalog.feeds].filter(([feed]) => feed.toUpperCase().includes(needle));
      const listed = await Promise.all(
        matching.map(async ([feed, sources]) => {
          const records = await reader.at(sources[endpoint], now);
          if (records.length === 0) return [];
          const latest = Math.max(...records.map(({ timestamp }) => Number(timestamp)));
          const providers = new Set(records.map(({ provider }) => provider)).size;
          return [{ feed, median: medianPrice(records), providers, latestSignedAt: iso(latest) }];
        })
      );
      const feeds = listed.flat();
      return { endpoint, count: feeds.length, feeds };
    }
    case 'get_price_at': {
      const endpoint = readEndpoint(args.endpoint);
      const sources = sourcesOf(catalog, args.feed, endpoint);
      const time = parseTime(args.time, 'time');
      const records = await reader.at(sources, time);
      const described = await describeRecords(catalog, String(args.feed), endpoint, records, time);
      const verified = records.filter((_, index) => described[index]?.verified);
      return {
        feed: args.feed,
        endpoint,
        time: iso(time),
        median: medianPrice(verified),
        providers: new Set(verified.map(({ provider }) => provider)).size,
        records: described,
        note:
          records.length === 0
            ? 'No signed records at or before this time.'
            : "Each record is the provider's latest at or before the time; ageSeconds says how much earlier it was signed.",
      };
    }
    case 'check_price': {
      const endpoint = readEndpoint(args.endpoint);
      sourcesOf(catalog, args.feed, endpoint);
      const sources = catalog.activeFeeds.get(String(args.feed))?.[endpoint] ?? [];
      const maxAge = readNumber(args.maxAgeSeconds, 'maxAgeSeconds', 300);
      const maxSpread = readNumber(args.maxSpreadBps, 'maxSpreadBps', 100);
      const records = await reader.at(sources, now);
      const described = await describeRecords(catalog, String(args.feed), endpoint, records, now);
      const verified = records.filter((_, index) => described[index]?.verified);
      const issues: string[] = [];
      if (verified.length === 0) issues.push('no verified signed records');
      const stale = described.filter(({ ageSeconds }) => ageSeconds > maxAge).map(({ provider }) => provider);
      if (stale.length > 0) issues.push(`stale (older than ${maxAge} s): ${[...new Set(stale)].join(', ')}`);
      const unverified = described.filter(({ verified: ok }) => !ok).map(({ provider }) => provider);
      if (unverified.length > 0) issues.push(`failed verification: ${unverified.join(', ')}`);
      const conflicting = [...new Set(described.filter(({ conflicting: c }) => c).map(({ provider }) => provider))];
      if (conflicting.length > 0) issues.push(`signed two values for one moment: ${conflicting.join(', ')}`);
      // One vote per provider, as with the median.
      const values = new Map(verified.map(({ provider, encodedValue }) => [provider, decodeValue(encodedValue)]));
      const spread = spreadBps([...values.values()]);
      if (spread === null) issues.push('providers disagree around a zero median; spread in bps is undefined');
      else if (spread > maxSpread) issues.push(`providers disagree by ${spread} bps (limit ${maxSpread})`);
      const signing = new Set(verified.map(({ provider }) => provider));
      const silent = [...new Set(sources.map(({ provider }) => provider))].filter((name) => !signing.has(name));
      if (silent.length > 0) issues.push(`no verified record from: ${silent.join(', ')}`);
      if (signing.size === 1) issues.push('only one provider signed a price');
      return {
        feed: args.feed,
        endpoint,
        verdict: issues.length === 0 ? 'ok' : 'warn',
        issues,
        median: medianPrice(verified),
        providers: signing.size,
        spreadBps: spread,
        newestAgeSeconds: described.length > 0 ? Math.min(...described.map(({ ageSeconds }) => ageSeconds)) : null,
        oldestAgeSeconds: described.length > 0 ? Math.max(...described.map(({ ageSeconds }) => ageSeconds)) : null,
        checkedAt: iso(now),
        records: described,
      };
    }
    case 'get_price_history': {
      const endpoint = readEndpoint(args.endpoint);
      const sources = sourcesOf(catalog, args.feed, endpoint);
      const from = parseTime(args.from, 'from');
      const to = parseTime(args.to, 'to');
      if (from > to) throw new ArgumentError('from must not be after to');
      const points = readCount(args.points, 'points', DEFAULT_HISTORY_POINTS, MAX_HISTORY_POINTS);
      const providers = (await reader.history(sources, from, to, points)).map(({ provider, points: series }) => {
        return { provider, points: series.map(({ timestamp, price }) => ({ signedAt: iso(timestamp), price })) };
      });
      const gaps = reader.gaps(sources, endpoint, from, to).map((gap) => ({ from: iso(gap.from), to: iso(gap.to) }));
      return { feed: args.feed, endpoint, from: iso(from), to: iso(to), providers, gapsWithoutData: gaps };
    }
    case 'get_conflicts': {
      const to = args.to === undefined ? now : parseTime(args.to, 'to');
      const from = args.from === undefined ? to - 24 * 60 * 60 : parseTime(args.from, 'from');
      if (from > to) throw new ArgumentError('from must not be after to');
      if (to - from > MAX_CONFLICT_SECONDS) throw new ArgumentError('the range must be at most 7 days');
      const summaries = (await summarizeConflicts(reader, catalog, from, to)).map((summary) => {
        const { feed, timestamp } = summary.widest;
        const endpoint = summary.endpoint === 'public' ? {} : { endpoint: summary.endpoint };
        const recheck = { tool: 'get_price_at', arguments: { feed, time: timestamp, ...endpoint } };
        return { ...summary, widest: { ...summary.widest, signedAt: iso(timestamp), recheck } };
      });
      return { from: iso(from), to: iso(to), summaries };
    }
    default:
      throw new UnknownTool(`unknown tool ${name}`);
  }
}

const reply = (id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id: id ?? null,
  result,
});
const fail = (id: JsonRpcRequest['id'], code: number, message: string): JsonRpcResponse => {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
};

const isId = (id: unknown): id is JsonRpcRequest['id'] => {
  return id === undefined || id === null || typeof id === 'string' || typeof id === 'number';
};

// Answers one JSON-RPC message. Notifications (no id), and responses a client sends back, get no answer: null.
export async function handleMcp(
  reader: Reader,
  configuredCatalog: Catalog,
  message: unknown,
  now = Math.floor(Date.now() / 1000)
): Promise<JsonRpcResponse | null> {
  const catalog = reader.catalog(configuredCatalog);
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return fail(null, -32600, 'expected a JSON-RPC request object');
  }
  const request = message as Partial<JsonRpcRequest> & { result?: unknown; error?: unknown };
  if (request.method === undefined && ('result' in request || 'error' in request)) return null;
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' || !isId(request.id)) {
    return fail(isId(request.id) ? request.id : null, -32600, 'expected a JSON-RPC 2.0 request');
  }
  log.debug('mcp request', { method: request.method });
  // A notification must not be answered, so nothing it asks for is worth doing; the ones MCP defines need no action.
  if (request.id === undefined) return null;
  const params = typeof request.params === 'object' && request.params !== null ? request.params : {};

  switch (request.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const client = (typeof params.clientInfo === 'object' && params.clientInfo) || {};
      log.info('mcp client connected', {
        client: 'name' in client ? String(client.name) : undefined,
        version: 'version' in client ? String(client.version) : undefined,
        protocolVersion: asked,
      });
      return reply(request.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'signed-archive', title: 'signed-archive', version: pkg.version },
        instructions:
          "Signed API3 price history. Every record carries its provider's signature, so prices can be verified " +
          'independently. Use get_price_at for a past moment, check_price before acting on a price, list_feeds to find ' +
          'feed names.',
      });
    }
    case 'ping':
      return reply(request.id, {});
    case 'tools/list':
      return reply(request.id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (
        typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}
      ) as ToolArguments;
      const startedAt = Date.now();
      const fields = { tool: name, feed: typeof args.feed === 'string' ? args.feed : undefined };
      try {
        const result = await callTool(reader, catalog, name, args, now);
        log.info('mcp tool called', { ...fields, durationMs: Date.now() - startedAt });
        return reply(request.id, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        });
      } catch (error) {
        const failed = { ...fields, durationMs: Date.now() - startedAt, error: errorMessage(error) };
        if (error instanceof UnknownTool) {
          log.info('mcp tool refused', failed);
          return fail(request.id, -32602, errorMessage(error));
        }
        if (error instanceof ArgumentError) {
          log.info('mcp tool refused', failed);
          return reply(request.id, { content: [{ type: 'text', text: errorMessage(error) }], isError: true });
        }
        // Internal details stay in the log; the agent only learns that the server failed.
        log.warn('mcp tool failed', failed);
        return reply(request.id, { content: [{ type: 'text', text: 'internal error' }], isError: true });
      }
    }
    default:
      return fail(request.id, -32601, `method not found: ${request.method}`);
  }
}

// One message, or a batch of them (protocol 2025-03-26 allows batches). Null when nothing needs an answer.
async function handleMessage(reader: Reader, catalog: Catalog, message: unknown) {
  if (!Array.isArray(message)) return handleMcp(reader, catalog, message);
  if (message.length === 0) return fail(null, -32600, 'empty batch');
  const responses: JsonRpcResponse[] = [];
  for (const item of message) {
    const response = await handleMcp(reader, catalog, item);
    if (response) responses.push(response);
  }
  return responses.length > 0 ? responses : null;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// Browsers send Origin with every cross-site POST, and with one from a page that rebound its own domain to this
// server, so only pages served from this machine may call the tools. Agents that aren't browsers send no Origin.
const isAllowedOrigin = (origin: string | null) => origin === null || LOOPBACK.has(URL.parse(origin)?.hostname ?? '');

// POST /mcp: JSON-RPC messages, answered as JSON (the stateless form of MCP's Streamable HTTP transport). A message
// that needs no answer gets 202 with no body.
export async function handleMcpHttp(reader: Reader, catalog: Catalog, request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('POST JSON-RPC messages here', { status: 405, headers: { allow: 'POST' } });
  }
  if (!isAllowedOrigin(request.headers.get('origin'))) {
    return Response.json(fail(null, -32600, 'origin not allowed'), { status: 403 });
  }
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return Response.json(fail(null, -32700, 'expected content-type application/json'), { status: 415 });
  }
  const version = request.headers.get('mcp-protocol-version');
  if (version !== null && !PROTOCOL_VERSIONS.includes(version)) {
    return Response.json(fail(null, -32600, `unsupported protocol version ${version}`), { status: 400 });
  }
  let message: unknown;
  try {
    message = await request.json();
  } catch {
    return Response.json(fail(null, -32700, 'invalid JSON'), { status: 400 });
  }
  const response = await handleMessage(reader, catalog, message);
  return response ? Response.json(response) : new Response(null, { status: 202 });
}

// Serves MCP over stdin and stdout, one JSON message per line, until stdin closes. Logs go to stderr, as always, so
// stdout carries nothing but protocol messages.
export async function runMcpStdio(
  reader: Reader,
  catalog: Catalog,
  input: NodeJS.ReadableStream = process.stdin,
  output: { write: (text: string) => unknown } = process.stdout
) {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify(fail(null, -32700, 'invalid JSON'))}\n`);
      continue;
    }
    const response = await handleMessage(reader, catalog, message);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}
