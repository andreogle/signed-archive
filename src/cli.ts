import { Command, InvalidArgumentError, Option } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { runArchiver } from './archiver.ts';
import { DEFAULT_DB_PATH, DEFAULT_HOST, DEFAULT_INTERVAL_SECONDS, DEFAULT_PORT } from './config.ts';
import { parseHeartbeatUrl } from './heartbeat.ts';
import { errorMessage, LOG_LEVELS, type LogLevel, log, setLogLevel } from './logger.ts';
import { DEFAULT_CONFIG_PATH, loadSettings, parseInterval, parsePort, parseSeconds } from './settings.ts';

// Command-line parsers report problems through commander, so bad input fails before anything runs.
const argParser = <T>(parse: (value: string) => T) => {
  return (value: string) => {
    try {
      return parse(value);
    } catch (error) {
      throw new InvalidArgumentError(errorMessage(error));
    }
  };
};

let config: Awaited<ReturnType<typeof loadSettings>>;
try {
  config = await loadSettings(process.argv, process.env);
} catch (error) {
  log.error('fatal', { error: errorMessage(error) });
  process.exit(1);
}
const { settings } = config;

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

interface ServeOptions {
  db: string;
  host: string;
  port: number;
}

// Loaded on demand so a plain archiver never pulls in the web bundle.
async function serve({ db, host, port }: ServeOptions) {
  const { startServer } = await import('./server.ts');
  return startServer({ dbPath: db, host, port });
}

const program = new Command()
  .name('signed-archive')
  .description("Record API3's public signed data so it has a verifiable history")
  .version(pkg.version)
  .addOption(
    new Option('--config <path>', `YAML config file (default: ${DEFAULT_CONFIG_PATH} if it exists)`).env('CONFIG')
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
    new Option('--heartbeat-url <url>', "URL to ping after each cycle that reached the API (dead man's switch)")
      .argParser(argParser(parseHeartbeatUrl))
      .default(settings.archive?.heartbeatUrl)
      .env('HEARTBEAT_URL')
  )
  .addOption(
    new Option('--serve', 'also serve the explorer, as the serve command does')
      .default(settings.archive?.serve ?? false)
      .env('SERVE')
  )
  .addOption(hostOption())
  .addOption(portOption())
  .action(async (options: ServeOptions & { interval: number; serve?: boolean; heartbeatUrl?: URL }) => {
    // runArchiver creates the database before its first await, so the read-only server can open it.
    const archiving = runArchiver({
      intervalSeconds: options.interval,
      dbPath: options.db,
      heartbeatUrl: options.heartbeatUrl,
      peers: settings.peers ?? [],
    });
    const server = options.serve ? await serve(options) : null;
    await archiving;
    // An open server keeps the process alive, so close it, and any open connections, once archiving stops.
    await server?.stop(true);
    if (server) log.info('server stopped');
  });

program
  .command('serve')
  .description('serve the explorer and its JSON API, reading the archive without writing to it')
  .addOption(dbOption())
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
    const result = await mergeArchive({ sourcePath: source, dbPath: db });
    const rejected = result.rejected + result.rejectedPolls;
    (rejected > 0 ? log.warn : log.info)('merge done', { source, ...result });
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
  .description('write a consistent, timestamped copy of the archive into a directory (safe while archiving)')
  .argument('<dir>', 'directory to write the copy into')
  .addOption(dbOption())
  .action(async (dir: string, { db }: { db: string }) => {
    const { backupArchive } = await import('./store.ts');
    const startedAt = Date.now();
    const path = backupArchive(db, dir);
    log.info('backup done', { path, durationMs: Date.now() - startedAt });
  });

try {
  await program.parseAsync();
} catch (error) {
  log.error('fatal', { error: errorMessage(error) });
  process.exit(1);
}
