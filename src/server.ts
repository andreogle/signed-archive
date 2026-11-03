import index from '../web/index.html';
import { handleApi } from './api.ts';
import type { Catalog } from './catalog.ts';
import { log } from './logger.ts';
import { handleMcpHttp } from './mcp.ts';
import { openReader } from './reader.ts';

export interface ServerOptions {
  dbPath: string;
  catalog: Catalog;
  host: string;
  port: number;
}

// Serves the explorer page and its JSON API. Bun bundles web/ (including the browser-side signature check) on start.
export function startServer({ dbPath, catalog, host, port }: ServerOptions) {
  const reader = openReader(dbPath);
  const server = Bun.serve({
    hostname: host,
    port,
    // Hot module reloading wraps each module on its own, which breaks the circular import inside
    // @tanstack/router-core (`replaceRouteChunk` reads as null). Development bundles stay unminified
    // and rebuild on change; reload the page to see an edit.
    development: process.env.NODE_ENV !== 'production' && { hmr: false },
    // MCP messages are the only request bodies, and a few KB each.
    maxRequestBodySize: 1024 * 1024,
    routes: {
      // Every other path is a page of the single-page app; the router in web/ picks what to show.
      '/*': index,
      // The API only reads.
      '/api/*': (request) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
        }
        return handleApi(reader, catalog, new URL(request.url));
      },
      // The archive as an MCP server for AI agents (see src/mcp.ts).
      '/mcp': (request) => handleMcpHttp(reader, catalog, request),
    },
  });
  log.info('server started', { url: server.url.href, db: dbPath });
  return server;
}
