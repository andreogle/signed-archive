import { dirname, join } from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { runArchiver } from './archiver.ts';
import { createCatalog } from './catalog.ts';
import { DEFAULT_DB_PATH, DEFAULT_HOST, DEFAULT_INTERVAL_SECONDS, DEFAULT_PORT } from './config.ts';
import { parseHeartbeatUrl } from './heartbeat.ts';
import { LOG_LEVELS, type LogLevel, log, setLogLevel } from './logger.ts';
import { DEFAULT_AFTER_DAYS } from './parquet.ts';
import { go, goSync } from './result.ts';
import {
  DEFAULT_CONFIG_PATH,
  loadSettings,
  parseDays,
  parseInterval,
  parsePort,
  parseSeconds,
  parseSwitch,
} from './settings.ts';

// Command-line parsers report problems through commander, so bad input fails before anything runs.
const argParser = <T>(parse: (value: string) => T) => {
  return (value: string) => {
    const [error, parsed] = goSync(() => parse(value));
    if (error) throw new InvalidArgumentError(error.message);
    return parsed;
  };
};

const [configError, config] = await go(() => loadSettings(process.argv, process.env));
if (configError) {
  log.error('fatal', { error: configError.message });
  process.exit(1);
}
const { settings } = config;
const catalog = createCatalog(config.catalog);

// Archiving, serving and merging need to know which airnodes and feeds exist; they come only from the config file.
function requireCatalog() {
  if (catalog.airnodes.length > 0) return catalog;
  throw new Error(
    `no airnodes configured: pass --config <path> (or CONFIG), or run from a directory with ${DEFAULT_CONFIG_PATH}`
  );
}

const dbOption = () => {
  return new Option('--db <path>', 'SQLite database path').default(settings.db ?? DEFAULT_DB_PATH).env('DB_PATH');
};
const hostOption = () => {
  return new Option('--host <host>', 'address to listen on').default(settings.serve?.host ?? DEFAULT_HOST).env('HOST');
};
const portOption = () => {
  return new Option('--port <port>', 'port to listen on')
    .argParser(argParser(parsePort))
    .default(settings.serve?.port ?? DEFAULT_PORT)
    .env('PORT');
};

// Moved days' files. Without a setting they sit in parquet/ next to the database, so a copied data directory (or the
// Docker volume) keeps them together.
const parquetDirOption = () => {
  return new Option('--parquet-dir <path>', 'directory of moved days as Parquet files (default: parquet/ beside --db)')
    .default(settings.parquet?.dir)
    .env('PARQUET_DIR');
};
const parquetDirOf = ({ db, parquetDir }: { db: string; parquetDir?: string | undefined }) => {
  return parquetDir ?? join(dirname(db), 'parquet');
};

interface ServeOptions {
  db: string;
  parquetDir?: string;
  host: string;
  port: number;
}

// Loaded on demand so a plain archiver never pulls in the web bundle.
async function serve(options: ServeOptions) {
  const { startServer } = await import('./server.ts');
  const { db, host, port } = options;
  return startServer({ dbPath: db, parquetDir: parquetDirOf(options), catalog: requireCatalog(), host, port });
}

const program = new Command()
  .name('signed-archive')
  .description("Record API3's public signed data so it has a verifiable history")
  .version(pkg.version)
  .addOption(
    new Option(
      '--config <path>',
      `YAML config file with settings, airnodes and feeds (default: ./${DEFAULT_CONFIG_PATH})`
    ).env('CONFIG')
  )
  .addOption(
    new Option('--log-level <level>', 'minimum log level')
      .choices(LOG_LEVELS)
      .default(settings.logLevel ?? 'info')
      .env('LOG_LEVEL')
  )
  .hook('preAction', (command) => {
    setLogLevel(command.opts<{ logLevel: LogLevel }>().logLevel);
    if (config.path) log.debug('config loaded', { path: config.path });
  });

program
  .command('archive', { isDefault: true })
  .description('poll the Signed API and store every new signed record')
  .addOption(
    new Option('--interval <seconds>', 'seconds per polling cycle')
      .argParser(argParser(parseInterval))
      .default(settings.archive?.interval ?? DEFAULT_INTERVAL_SECONDS)
      .env('POLL_INTERVAL_SECONDS')
  )
  .addOption(dbOption())
  .addOption(
    new Option(
      '--catalog-auto-update [on]',
      'discover API3 catalogue updates hourly without restarting (true or false)'
    )
      .argParser(argParser(parseSwitch))
      .preset(true)
      .default(settings.catalog?.autoUpdate ?? false)
      .env('CATALOG_AUTO_UPDATE')
  )
  .addOption(
    new Option('--heartbeat-url <url>', "URL to ping after each cycle that reached the API (dead man's switch)")
      .argParser(argParser(parseHeartbeatUrl))
      // The URL is a secret, so help says where it came from instead of printing it.
      .default(settings.archive?.heartbeatUrl, settings.archive?.heartbeatUrl ? 'set in the config file' : undefined)
      .env('HEARTBEAT_URL')
  )
  .addOption(
    new Option('--serve [on]', 'also serve the explorer, as the serve command does (true or false)')
      .argParser(argParser(parseSwitch))
      .preset(true)
      .default(settings.archive?.serve ?? false)
      .env('SERVE')
  )
  .addOption(parquetDirOption())
  .addOption(
    new Option('--parquet-after-days <days>', 'move a closed day to Parquet once it ended this many days ago')
      .argParser(argParser(parseDays))
      .default(settings.parquet?.afterDays ?? DEFAULT_AFTER_DAYS)
      .env('PARQUET_AFTER_DAYS')
  )
  .addOption(hostOption())
  .addOption(portOption())
  .action(
    async (
      options: ServeOptions & {
        interval: number;
        serve?: boolean;
        heartbeatUrl?: URL;
        parquetAfterDays: number;
        catalogAutoUpdate: boolean;
      }
    ) => {
      // runArchiver creates the database before its first await, so the read-only server can open it.
      const archiving = runArchiver({
        intervalSeconds: options.interval,
        dbPath: options.db,
        catalog: requireCatalog(),
        heartbeatUrl: options.heartbeatUrl,
        peers: settings.peers ?? [],
        parquetDir: parquetDirOf(options),
        afterDays: options.parquetAfterDays,
        discoverCatalog: options.catalogAutoUpdate,
      });
      const server = options.serve ? await serve(options) : null;
      await archiving;
      // An open server keeps the process alive, so close it, and any open connections, once archiving stops.
      await server?.stop(true);
      if (server) log.info('server stopped');
    }
  );

program
  .command('serve')
  .description('serve the explorer and its JSON API, reading the archive without writing to it')
  .addOption(dbOption())
  .addOption(parquetDirOption())
  .addOption(hostOption())
  .addOption(portOption())
  .action(async (options: ServeOptions) => {
    await serve(options);
  });

program
  .command('merge')
  .description("add another archive's records to this one, re-checking every signature; nothing is overwritten")
  .argument('<source>', 'path of the archive to copy from (a copy made with VACUUM INTO, not a live file)')
  .addOption(dbOption())
  .action(async (source: string, { db }: { db: string }) => {
    const { mergeArchive } = await import('./merge.ts');
    const result = await mergeArchive({ sourcePath: source, dbPath: db, catalog: requireCatalog() });
    const rejected = result.rejected + result.rejectedPolls;
    (rejected > 0 ? log.warn : log.info)('merge done', { source, ...result });
  });

program
  .command('mcp')
  .description('serve the archive to AI agents over MCP on stdin and stdout (read-only)')
  .addOption(dbOption())
  .addOption(parquetDirOption())
  .action(async (options: { db: string; parquetDir?: string }) => {
    const [{ openReader }, { runMcpStdio }] = await Promise.all([import('./reader.ts'), import('./mcp.ts')]);
    const reader = openReader(options.db, { parquetDir: parquetDirOf(options) });
    await runMcpStdio(reader, requireCatalog());
    reader.close();
  });

program
  .command('health')
  .description('exit 0 if the archiver recorded a request recently, 1 otherwise (for container health checks)')
  .addOption(dbOption())
  .addOption(
    new Option('--max-age <seconds>', 'oldest acceptable last request')
      .argParser(argParser(parseSeconds))
      .default(settings.health?.maxAge ?? 300)
      .env('HEALTH_MAX_AGE_SECONDS')
  )
  .action(async ({ db, maxAge }: { db: string; maxAge: number }) => {
    const { openReader } = await import('./reader.ts');
    const reader = openReader(db);
    const last = reader.lastPoll();
    reader.close();
    const lastPollAgeSeconds = last === null ? undefined : Math.round((Date.now() - last) / 1000);
    if (lastPollAgeSeconds === undefined || lastPollAgeSeconds > maxAge) {
      log.warn('unhealthy', { lastPollAgeSeconds, maxAgeSeconds: maxAge });
      process.exitCode = 1;
    } else {
      log.debug('healthy', { lastPollAgeSeconds });
    }
  });

program
  .command('backup')
  .description('write a consistent, timestamped copy of the archive, and any Parquet files it lacks, into a directory')
  .argument('<dir>', 'directory to write the copy into')
  .addOption(dbOption())
  .addOption(parquetDirOption())
  .action(async (dir: string, options: { db: string; parquetDir?: string }) => {
    const { backupArchive } = await import('./store.ts');
    const startedAt = Date.now();
    const { path, parquetCopied } = await backupArchive(options.db, dir, { parquetDir: parquetDirOf(options) });
    log.info('backup done', { path, parquetCopied, durationMs: Date.now() - startedAt });
  });

const [fatal] = await go(() => program.parseAsync());
if (fatal) {
  log.error('fatal', { error: fatal.message });
  process.exit(1);
}
