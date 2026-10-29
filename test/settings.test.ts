import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, parseSettings } from '../src/settings.ts';

const dir = mkdtempSync(join(tmpdir(), 'signed-archive-settings-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseSettings', () => {
  test('reads every setting, with the same parsing as the command line', () => {
    const settings = parseSettings(`
db: /data/archive.sqlite
logLevel: debug
archive:
  interval: 120
  heartbeatUrl: https://hc-ping.com/abc
  serve: true
serve:
  host: 0.0.0.0
  port: 8080
health:
  maxAge: 600
peers:
  - https://archive.example.org
  - https://archive.example.org
  - http://10.0.0.2:3000/archive/
`);
    expect(settings).toMatchObject({
      db: '/data/archive.sqlite',
      logLevel: 'debug',
      archive: { interval: 120, serve: true },
      serve: { host: '0.0.0.0', port: 8080 },
      health: { maxAge: 600 },
    });
    expect(settings.archive?.heartbeatUrl?.host).toBe('hc-ping.com');
    // Duplicates collapse, so a peer is never asked twice.
    expect(settings.peers?.map(({ href }) => href)).toEqual([
      'https://archive.example.org/',
      'http://10.0.0.2:3000/archive/',
    ]);
  });

  test('treats an empty file, or an empty key, as no settings', () => {
    expect(parseSettings('')).toEqual({});
    expect(parseSettings('archive:\n  interval:\n')).toEqual({ archive: {} });
  });

  test('rejects misspelled keys and bad values, naming the setting', () => {
    expect(() => parseSettings('archve:\n  interval: 60')).toThrow('config: archve is not a known setting');
    expect(() => parseSettings('archive:\n  intervl: 60')).toThrow('config: archive.intervl is not a known setting');
    expect(() => parseSettings('archive:\n  interval: 5')).toThrow('config: archive.interval must be a number >= 15');
    expect(() => parseSettings('serve:\n  port: 70000')).toThrow('config: serve.port must be 1-65535');
    expect(() => parseSettings('logLevel: loud')).toThrow('config: logLevel must be one of');
    expect(() => parseSettings('peers: https://a.example')).toThrow('config: peers must be a list of URLs');
    expect(() => parseSettings('peers:\n  - ftp://a.example')).toThrow('config: peers[0] must be an http(s) URL');
    expect(() => parseSettings('peers:\n  - [1]')).toThrow('config: peers[0] must be a string or number');
    expect(() => parseSettings('archive:\n  serve: yes please')).toThrow('config: archive.serve must be true or false');
    expect(() => parseSettings('db: ""')).toThrow('config: db must be a non-empty string');
    expect(() => parseSettings('serve: 3000')).toThrow('config: serve must be a mapping');
  });
});

describe('airnodes and feeds', () => {
  const airnode = '0x9dB03a07bE313B3C08261B1d1606D511f3560D9e';
  const template = '0xdeda2f7938bf877d2f011aa550852d3459794e16944ea0b7513465479752ba93';
  const lists = (airnodes: string, feeds = '') => parseSettings(`airnodes:\n${airnodes}\nfeeds:\n${feeds}`);
  const entry = (alias: string, address = `"${airnode}"`, url = 'https://signed-api.coingecko.com') =>
    `  - alias: ${alias}\n    airnode: ${address}\n    signedApiUrl: ${url}`;

  test('reads providers and feeds, and the committed config file parses', async () => {
    const settings = lists(entry('coingecko'), `  ETH/USD:\n    coingecko: "${template}"`);
    expect(settings.airnodes).toEqual([
      { alias: 'coingecko', airnode, signedApiUrl: 'https://signed-api.coingecko.com' },
    ]);
    expect(settings.feeds).toEqual({ 'ETH/USD': { coingecko: template } });
    const committed = parseSettings(await Bun.file(new URL('../signed-archive.yaml', import.meta.url)).text());
    expect(committed.airnodes?.length).toBeGreaterThan(0);
  });

  test('rejects unquoted hex, missing fields, duplicate aliases and feeds naming unknown providers', () => {
    // YAML reads a short unquoted 0x... as a number, which has lost the value's exact digits.
    expect(() => lists(entry('coingecko', '0x12'))).toThrow('airnodes[0].airnode must be an address, quoted');
    expect(() => lists('  - alias: coingecko')).toThrow('airnodes[0].airnode is required');
    expect(() => lists(`${entry('coingecko')}\n${entry('coingecko')}`)).toThrow('has alias coingecko twice');
    expect(() => lists(entry('coingecko', `"${airnode}"`, 'ftp://x'))).toThrow('signedApiUrl must be an http(s) URL');
    expect(() => lists(entry('coingecko'), `  ETH/USD:\n    nobody: "${template}"`)).toThrow(
      'feeds.ETH/USD.nobody is not an alias listed under airnodes'
    );
    expect(() => lists(entry('coingecko'), '  ETH/USD:\n    coingecko: 0x12')).toThrow('must be a 32-byte hex string');
    expect(() => lists(entry('coingecko'), '  ETH/USD:\n    coingecko: "0x12"')).toThrow(
      'must be a 32-byte hex string'
    );
    expect(() => lists(entry('coingecko'), '  ETH/USD: 5')).toThrow('feeds.ETH/USD must map provider aliases');
    expect(() => parseSettings('airnodes: 5')).toThrow('airnodes must be a list');
    expect(() => parseSettings('feeds: [1]')).toThrow('feeds must be a mapping');
  });
});

describe('loadSettings', () => {
  const path = join(dir, 'archive.yaml');
  writeFileSync(path, 'archive:\n  interval: 90\n');

  test('reads the file named by --config, --config=, or CONFIG', async () => {
    for (const [argv, env] of [
      [['bun', 'cli.ts', '--config', path], {}],
      [['bun', 'cli.ts', `--config=${path}`], {}],
      [['bun', 'cli.ts'], { CONFIG: path }],
    ] as const) {
      expect(await loadSettings(argv, env)).toEqual({ path, settings: { archive: { interval: 90 } } });
    }
  });

  test('a missing default file means no settings; a missing named file is an error', async () => {
    // The default file is looked up in the working directory, so look from one that has none.
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(await loadSettings(['bun', 'cli.ts'], {})).toEqual({ path: null, settings: {} });
    } finally {
      process.chdir(cwd);
    }
    await expect(loadSettings(['bun', 'cli.ts', '--config', join(dir, 'nope.yaml')], {})).rejects.toThrow(
      'config file not found'
    );
  });
});
