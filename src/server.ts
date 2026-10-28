import index from '../web/index.html';
import { handleApi } from './api.ts';
import { log } from './logger.ts';
import { openReader } from './reader.ts';

export interface ServerOptions {
  dbPath: string;
  host: string;
  port: number;
}

// Serves the explorer page and its JSON API. Bun bundles web/ (including the browser-side signature check) on start.
export function startServer({ dbPath, host, port }: ServerOptions) {
  const reader = openReader(dbPath);
  const server = Bun.serve({
    hostname: host,
    port,
    // Hot module reloading wraps each module on its own, which breaks the circular import inside
    // @tanstack/router-core (`replaceRouteChunk` reads as null). Development bundles stay unminified
    // and rebuild on change; reload the page to see an edit.
    development: process.env.NODE_ENV !== 'production' && { hmr: false },
    routes: {
      // Every other path is a page of the single-page app; the router in web/ picks what to show.
      '/*': index,
      '/api/*': (request) => handleApi(reader, new URL(request.url)),
    },
  });
  log.info('server started', { url: server.url.href, db: dbPath });
  return server;
}
