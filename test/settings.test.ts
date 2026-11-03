import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadSettings, parseAirnodes, parseFeeds, parseSettings, parseSwitch } from '../src/settings.ts';

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
parquet:
  dir: /data/parquet
  afterDays: 3
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
      parquet: { dir: '/data/parquet', afterDays: 3 },
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
    // Keys every object inherits are not settings either.
    expect(() => parseSettings('constructor: 1')).toThrow('config: constructor is not a known setting');
    expect(() => parseSettings('archive:\n  toString: 1')).toThrow('archive.toString is not a known setting');
    expect(() => parseSettings('archive:\n  interval: 5')).toThrow('config: archive.interval must be a number >= 15');
    expect(() => parseSettings('serve:\n  port: 70000')).toThrow('config: serve.port must be 1-65535');
    expect(() => parseSettings('logLevel: loud')).toThrow('config: logLevel must be one of');
    expect(() => parseSettings('peers: https://a.example')).toThrow('config: peers must be a list of URLs');
    expect(() => parseSettings('peers:\n  - ftp://a.example')).toThrow('config: peers[0] must be an http(s) URL');
    expect(() => parseSettings('peers:\n  - [1]')).toThrow('config: peers[0] must be a string or number');
    expect(() => parseSettings('archive:\n  serve: yes please')).toThrow('config: archive.serve must be true or false');
    expect(() => parseSettings('db: ""')).toThrow('config: db must be a non-empty string');
    expect(() => parseSettings('serve: 3000')).toThrow('config: serve must be a mapping');
    expect(() => parseSettings('parquet:\n  afterDays: 0')).toThrow(
      'config: parquet.afterDays must be a whole number of days'
    );
    expect(() => parseSettings('parquet:\n  afterDays: 1.5')).toThrow(
      'config: parquet.afterDays must be a whole number'
    );
  });
});

describe('airnode and feed lists', () => {
  const airnode = '0x9dB03a07bE313B3C08261B1d1606D511f3560D9e';
  const template = '0xdeda2f7938bf877d2f011aa550852d3459794e16944ea0b7513465479752ba93';
  const entry = (alias: string, address = `"${airnode}"`, url = 'https://signed-api.coingecko.com') =>
    `  - alias: ${alias}\n    airnode: ${address}\n    signedApiUrl: ${url}`;
  const airnodeList = (...entries: string[]) => parseAirnodes(`airnodes:\n${entries.join('\n')}`);
  const feedList = (body: string) => parseFeeds(`feeds:\n${body}`, airnodeList(entry('coingecko')));

  test('reads providers and feeds, and the committed files parse', async () => {
    expect(airnodeList(entry('coingecko'))).toEqual([
      { alias: 'coingecko', airnode, signedApiUrl: 'https://signed-api.coingecko.com' },
    ]);
    expect(feedList(`  ETH/USD:\n    coingecko: "${template}"`)).toEqual({ 'ETH/USD': { coingecko: template } });
    const committed = await loadConfig(fileURLToPath(new URL('../signed-archive.yaml', import.meta.url)));
    expect(committed.catalog.airnodes.length).toBeGreaterThan(0);
    expect(Object.keys(committed.catalog.feeds).length).toBeGreaterThan(0);
    expect(parseAirnodes('')).toEqual([]);
    expect(parseFeeds('', [])).toEqual({});
  });

  test('rejects unquoted hex, missing fields, duplicate aliases and feeds naming unknown providers', () => {
    // YAML reads a short unquoted 0x... as a number, which has lost the value's exact digits.
    expect(() => airnodeList(entry('coingecko', '0x12'))).toThrow('airnodes[0].airnode must be an address, quoted');
    expect(() => airnodeList('  - alias: coingecko')).toThrow('airnodes[0].airnode is required');
    expect(() => airnodeList(entry('coingecko'), entry('coingecko'))).toThrow('has alias coingecko twice');
    expect(() => airnodeList(entry('coingecko', `"${airnode}"`, 'ftp://x'))).toThrow(
      'signedApiUrl must be an http(s) URL'
    );
    expect(() => feedList(`  ETH/USD:\n    nobody: "${template}"`)).toThrow(
      'feeds.ETH/USD.nobody is not an alias listed in the airnodes file'
    );
    expect(() => feedList('  ETH/USD:\n    coingecko: 0x12')).toThrow('must be a 32-byte hex string');
    expect(() => feedList('  ETH/USD:\n    coingecko: "0x12"')).toThrow('must be a 32-byte hex string');
    expect(() => feedList('  ETH/USD: 5')).toThrow('feeds.ETH/USD must map provider aliases');
    expect(() => parseAirnodes('airnodes: 5')).toThrow('airnodes must be a list');
    expect(() => parseFeeds('feeds: [1]', [])).toThrow('feeds must be a mapping');
    // Each list file holds only its own key.
    expect(() => parseAirnodes('feeds: {}')).toThrow('feeds is not a known setting');
  });
});

test('parseSwitch reads true and false as a flag value or env var gives them, and refuses anything else', () => {
  expect(['true', '1', 'yes', 'ON'].map(parseSwitch)).toEqual([true, true, true, true]);
  expect(['false', '0', 'no', 'Off'].map(parseSwitch)).toEqual([false, false, false, false]);
  expect(() => parseSwitch('maybe')).toThrow('must be true or false');
});

describe('loadSettings', () => {
  // A settings file with its list files beside it, at paths relative to the settings file.
  const path = join(dir, 'archive.yaml');
  writeFileSync(
    path,
    'db: data/archive.sqlite\narchive:\n  interval: 90\nparquet:\n  dir: cold\ncatalog:\n  airnodes: lists/a.yaml\n  feeds: lists/f.yaml\n'
  );
  mkdirSync(join(dir, 'lists'), { recursive: true });
  writeFileSync(
    join(dir, 'lists/a.yaml'),
    'airnodes:\n  - alias: x\n    airnode: "0x9dB03a07bE313B3C08261B1d1606D511f3560D9e"\n    signedApiUrl: https://x.example\n'
  );
  writeFileSync(join(dir, 'lists/f.yaml'), 'feeds:\n  X/USD: {}\n');
  const expected: Awaited<ReturnType<typeof loadConfig>> = {
    path,
    // The database path is relative to the settings file, like the list paths, not to the working directory.
    settings: {
      db: join(dir, 'data/archive.sqlite'),
      archive: { interval: 90 },
      parquet: { dir: join(dir, 'cold') },
      catalog: { airnodes: 'lists/a.yaml', feeds: 'lists/f.yaml' },
    },
    catalog: {
      airnodes: [
        { alias: 'x', airnode: '0x9dB03a07bE313B3C08261B1d1606D511f3560D9e', signedApiUrl: 'https://x.example' },
      ],
      feeds: { 'X/USD': {} },
    },
  };

  test('reads the file named by --config, --config=, or CONFIG', async () => {
    for (const [argv, env] of [
      [['bun', 'cli.ts', '--config', path], {}],
      [['bun', 'cli.ts', `--config=${path}`], {}],
      [['bun', 'cli.ts'], { CONFIG: path }],
    ] as const) {
      expect(await loadSettings(argv, env)).toEqual(expected);
    }
  });

  test('preserves equals signs in a config path and uses the last flag, like commander', async () => {
    const withEquals = join(dir, 'archive=copy.yaml');
    writeFileSync(withEquals, await Bun.file(path).text());
    expect((await loadSettings(['bun', 'cli.ts', `--config=${withEquals}`], {})).path).toBe(withEquals);
    expect((await loadSettings(['bun', 'cli.ts', '--config', 'missing.yaml', '--config', path], {})).path).toBe(path);
  });

  test('a missing default file means no settings; a missing named file is an error', async () => {
    // The default file is looked up in the working directory, so look from one that has none.
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(await loadSettings(['bun', 'cli.ts'], {})).toEqual({
        path: null,
        settings: {},
        catalog: { airnodes: [], feeds: {} },
      });
    } finally {
      process.chdir(cwd);
    }
    await expect(loadSettings(['bun', 'cli.ts', '--config', join(dir, 'nope.yaml')], {})).rejects.toThrow(
      'config file not found'
    );
    // A settings file whose list files are missing names the path it looked for.
    const lonely = join(dir, 'lonely.yaml');
    writeFileSync(lonely, 'logLevel: info\n');
    await expect(loadConfig(lonely)).rejects.toThrow(`catalog file not found: ${join(dir, 'config/airnodes.yaml')}`);
  });
});
