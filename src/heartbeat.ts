import { REQUEST_TIMEOUT_MS, USER_AGENT } from './config.ts';
import { errorMessage, log } from './logger.ts';
import { go } from './result.ts';

// Pings an outside monitor (healthchecks.io, an Uptime Kuma push monitor, ...) after each cycle that reached the API,
// so the monitor alerts when pings stop: a crashed, stuck or cut-off archiver all look the same to it. A failed ping
// is logged and never stops archiving. The URL usually embeds a secret token, so only its host is ever logged.
export async function sendHeartbeat(url: URL) {
  const [error, response] = await go(() => {
    return fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  });
  if (error) {
    log.warn('heartbeat failed', { host: url.host, error: errorMessage(error) });
    return false;
  }
  if (!response.ok) log.warn('heartbeat failed', { host: url.host, status: response.status });
  return response.ok;
}

// Accepts an http(s) URL; an empty value (an unset variable in compose.yaml) means no heartbeat.
export function parseHeartbeatUrl(value: string): URL | undefined {
  if (value === '') return undefined;
  const url = URL.canParse(value) ? new URL(value) : null;
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new Error('must be an http(s) URL');
  return url;
}
