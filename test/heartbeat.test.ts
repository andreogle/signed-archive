import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { parseHeartbeatUrl, sendHeartbeat } from '../src/heartbeat.ts';

const seen: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch: (request) => {
    seen.push(new URL(request.url).pathname);
    return new Response(null, { status: new URL(request.url).pathname === '/down' ? 503 : 200 });
  },
});

afterAll(() => {
  void server.stop(true);
});

describe('sendHeartbeat', () => {
  test('pings the URL and reports success', async () => {
    expect(await sendHeartbeat(new URL('/ping/secret-token', server.url))).toBe(true);
    expect(seen).toContain('/ping/secret-token');
  });

  test('reports failure without throwing, and never logs the secret path', async () => {
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await sendHeartbeat(new URL('/down', server.url))).toBe(false);
    expect(await sendHeartbeat(new URL('http://127.0.0.1:1/secret-token'))).toBe(false);
    const lines = stderr.mock.calls.map(([line]) => String(line));
    stderr.mockRestore();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('status=503');
    for (const line of lines) expect(line).not.toContain('secret-token');
  });
});

describe('parseHeartbeatUrl', () => {
  test('accepts http(s) URLs and treats an empty value as unset', () => {
    expect(parseHeartbeatUrl('https://hc-ping.com/abc')?.host).toBe('hc-ping.com');
    expect(parseHeartbeatUrl('')).toBeUndefined();
  });

  test('rejects anything else', () => {
    expect(() => parseHeartbeatUrl('hc-ping.com/abc')).toThrow();
    expect(() => parseHeartbeatUrl('file:///etc/passwd')).toThrow();
  });
});
