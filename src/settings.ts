import { existsSync } from 'node:fs';
import { MIN_INTERVAL_SECONDS } from './config.ts';
import { parseHeartbeatUrl } from './heartbeat.ts';
import { LOG_LEVELS, type LogLevel } from './logger.ts';

// The optional config file. Every key mirrors a command-line option; precedence is flag, then environment variable,
// then this file, then the built-in default. A missing default file is fine; a misspelled key is an error, so a typo
// never silently falls back to a default.
export const DEFAULT_CONFIG_PATH = 'signed-archive.yaml';

export interface Settings {
  db?: string;
  logLevel?: LogLevel;
  archive?: { interval?: number; heartbeatUrl?: URL; serve?: boolean };
  serve?: { host?: string; port?: number };
  health?: { maxAge?: number };
  // Other archives to ask for records this one missed. See src/repair.ts.
  peers?: URL[];
}

export function parseInterval(value: string) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < MIN_INTERVAL_SECONDS)
    throw new Error(`must be a number >= ${MIN_INTERVAL_SECONDS}`);
  return seconds;
}

export function parsePort(value: string) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('must be 1-65535');
  return port;
}

export function parseSeconds(value: string) {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 1) throw new Error('must be a whole number of seconds');
  return seconds;
}

export function parsePeerUrl(value: string) {
  const url = URL.canParse(value) ? new URL(value) : null;
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new Error('must be an http(s) URL');
  return url;
}

type Shape = Record<string, (value: unknown, path: string) => unknown>;

const fail = (path: string, message: string): never => {
  throw new Error(`config: ${path} ${message}`);
};

// Runs a command-line parser on a config value, so the file and the flag accept exactly the same things.
const scalar = (parse: (value: string) => unknown) => {
  return (value: unknown, path: string) => {
    if (typeof value !== 'string' && typeof value !== 'number') return fail(path, 'must be a string or number');
    try {
      return parse(String(value));
    } catch (error) {
      return fail(path, error instanceof Error ? error.message : String(error));
    }
  };
};

const text = (value: unknown, path: string) =>
  typeof value === 'string' && value !== '' ? value : fail(path, 'must be a non-empty string');
const flag = (value: unknown, path: string) =>
  typeof value === 'boolean' ? value : fail(path, 'must be true or false');

const section = (shape: Shape) => {
  return (value: unknown, path: string) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(path, 'must be a mapping');
    const result: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      const parse = shape[key];
      if (!parse)
        return fail(path ? `${path}.${key}` : key, `is not a known setting (known: ${Object.keys(shape).join(', ')})`);
      if (field !== null) result[key] = parse(field, path ? `${path}.${key}` : key);
    }
    return result;
  };
};

const peers = (value: unknown, path: string) => {
  if (!Array.isArray(value)) return fail(path, 'must be a list of URLs');
  const urls = value.map((entry, index) => scalar(parsePeerUrl)(entry, `${path}[${index}]`) as URL);
  return [...new Map(urls.map((url) => [url.href, url])).values()];
};

const SETTINGS = section({
  db: text,
  logLevel: (value, path) =>
    LOG_LEVELS.includes(value as LogLevel) ? value : fail(path, `must be one of ${LOG_LEVELS.join(', ')}`),
  archive: section({ interval: scalar(parseInterval), heartbeatUrl: scalar(parseHeartbeatUrl), serve: flag }),
  serve: section({ host: text, port: scalar(parsePort) }),
  health: section({ maxAge: scalar(parseSeconds) }),
  peers,
});

// Parses and checks the YAML text of a config file. An empty file means no settings.
export function parseSettings(yaml: string): Settings {
  const document: unknown = Bun.YAML.parse(yaml);
  return document === null || document === undefined ? {} : (SETTINGS(document, '') as Settings);
}

// Reads the config file named by --config or CONFIG, or the default file if it exists. The path is found before
// commander runs, because the file supplies commander's defaults.
export async function loadSettings(argv: readonly string[], env: Record<string, string | undefined>) {
  const flagIndex = argv.findIndex((arg) => arg === '--config' || arg.startsWith('--config='));
  const fromFlag = flagIndex === -1 ? undefined : (argv[flagIndex]?.split('=')[1] ?? argv[flagIndex + 1]);
  const explicit = fromFlag ?? (env.CONFIG || undefined);
  const path = explicit ?? DEFAULT_CONFIG_PATH;
  if (!explicit && !existsSync(path)) return { path: null, settings: {} as Settings };
  if (!existsSync(path)) throw new Error(`config file not found: ${path}`);
  return { path, settings: parseSettings(await Bun.file(path).text()) };
}
