import { existsSync } from 'node:fs';
import { type Hex, isAddress } from 'viem';
import type { AirnodeEntry, CatalogInput } from './catalog.ts';
import { MIN_INTERVAL_SECONDS } from './config.ts';
import { parseHeartbeatUrl } from './heartbeat.ts';
import { LOG_LEVELS, type LogLevel } from './logger.ts';

// The config file: the one place for settings and for what to archive. Setting keys mirror command-line options;
// precedence is flag, then environment variable, then this file, then the built-in default. `airnodes` and `feeds`
// are generated below a marker line by `bun run airnodes`. A misspelled key is an error, so a typo never silently
// falls back to a default.
export const DEFAULT_CONFIG_PATH = 'signed-archive.yaml';

export interface Settings {
  db?: string;
  logLevel?: LogLevel;
  archive?: { interval?: number; heartbeatUrl?: URL; serve?: boolean };
  serve?: { host?: string; port?: number };
  health?: { maxAge?: number };
  // Other archives to ask for records this one missed. See src/repair.ts.
  peers?: URL[];
  airnodes?: AirnodeEntry[];
  feeds?: CatalogInput['feeds'];
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

// Addresses and template IDs are hex strings. Quote them: YAML may read an unquoted 0x... as a number (Bun does for
// short values, other tools for any), and a number has lost the value's exact digits.
const hexString = (bytes: number) => {
  return (value: unknown, path: string) => {
    const ok = typeof value === 'string' && value.length === 2 + bytes * 2 && /^0x[0-9a-fA-F]+$/.test(value);
    return ok ? value : fail(path, `must be a ${bytes}-byte hex string, quoted`);
  };
};

const airnodes = (value: unknown, path: string) => {
  if (!Array.isArray(value)) return fail(path, 'must be a list');
  const entry = section({
    alias: text,
    airnode: (field, at) =>
      isAddress(String(field)) ? hexString(20)(field, at) : fail(at, 'must be an address, quoted'),
    signedApiUrl: (field, at) => (scalar(parsePeerUrl)(field, at) as URL).href.replace(/\/$/, ''),
  });
  const list = value.map((item, index) => entry(item, `${path}[${index}]`) as Partial<AirnodeEntry>);
  list.forEach((item, index) => {
    for (const key of ['alias', 'airnode', 'signedApiUrl'] as const) {
      if (item[key] === undefined) fail(`${path}[${index}].${key}`, 'is required');
    }
  });
  const aliases = list.map(({ alias }) => alias);
  const duplicate = aliases.find((alias, index) => aliases.indexOf(alias) !== index);
  if (duplicate) fail(path, `has alias ${duplicate} twice`);
  return list as AirnodeEntry[];
};

const feeds = (value: unknown, path: string) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(path, 'must be a mapping');
  const result: Record<string, Record<string, Hex>> = {};
  for (const [name, providers] of Object.entries(value)) {
    if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) {
      fail(`${path}.${name}`, 'must map provider aliases to template IDs');
    }
    result[name] = Object.fromEntries(
      Object.entries(providers as object).map(([alias, id]) => [
        alias,
        hexString(32)(id, `${path}.${name}.${alias}`) as Hex,
      ])
    );
  }
  return result;
};

const SETTINGS = section({
  db: text,
  logLevel: (value, path) =>
    LOG_LEVELS.includes(value as LogLevel) ? value : fail(path, `must be one of ${LOG_LEVELS.join(', ')}`),
  archive: section({ interval: scalar(parseInterval), heartbeatUrl: scalar(parseHeartbeatUrl), serve: flag }),
  serve: section({ host: text, port: scalar(parsePort) }),
  health: section({ maxAge: scalar(parseSeconds) }),
  peers,
  airnodes,
  feeds,
});

// Parses and checks the YAML text of a config file. An empty file means no settings.
export function parseSettings(yaml: string): Settings {
  const document: unknown = Bun.YAML.parse(yaml);
  const settings = document === null || document === undefined ? {} : (SETTINGS(document, '') as Settings);
  // Every feed provider must be a configured airnode, or its records could never be checked.
  const known = new Set((settings.airnodes ?? []).map(({ alias }) => alias));
  for (const [name, providers] of Object.entries(settings.feeds ?? {})) {
    for (const alias of Object.keys(providers)) {
      if (!known.has(alias)) fail(`feeds.${name}.${alias}`, 'is not an alias listed under airnodes');
    }
  }
  return settings;
}

// What to archive, from the settings. Empty when the config file has no airnodes.
export const catalogInput = (settings: Settings): CatalogInput => {
  return { airnodes: settings.airnodes ?? [], feeds: settings.feeds ?? {} };
};

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
