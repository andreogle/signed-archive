import { Command, InvalidArgumentError, Option } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { runArchiver } from './archiver.ts';
import { DEFAULT_DB_PATH, DEFAULT_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS } from './config.ts';
import { errorMessage, LOG_LEVELS, type LogLevel, log, setLogLevel } from './logger.ts';

function parseInterval(value: string) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < MIN_INTERVAL_SECONDS) {
    throw new InvalidArgumentError(`must be a number >= ${MIN_INTERVAL_SECONDS}`);
  }
  return seconds;
}

const program = new Command()
  .name('signed-archive')
  .description("Record API3's public signed data so it has a verifiable history")
  .version(pkg.version)
  .addOption(
    new Option('--log-level <level>', 'minimum log level').choices(LOG_LEVELS).default('info').env('LOG_LEVEL')
  )
  .hook('preAction', (command) => {
    setLogLevel(command.opts<{ logLevel: LogLevel }>().logLevel);
  });

program
  .command('archive', { isDefault: true })
  .description('poll the Signed API and store every new signed record')
  .addOption(
    new Option('--interval <seconds>', 'seconds per polling cycle')
      .argParser(parseInterval)
      .default(DEFAULT_INTERVAL_SECONDS)
      .env('POLL_INTERVAL_SECONDS')
  )
  .addOption(new Option('--db <path>', 'SQLite database path').default(DEFAULT_DB_PATH).env('DB_PATH'))
  .action(async ({ interval, db }: { interval: number; db: string }) => {
    await runArchiver({ intervalSeconds: interval, dbPath: db });
  });

try {
  await program.parseAsync();
} catch (error) {
  log.error('fatal', { error: errorMessage(error) });
  process.exit(1);
}
