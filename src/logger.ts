// Logs are lines on stderr like `14:15:23.917 [info] cycle done saved=2116 rejected=0`: local
// wall-clock time, level, message, then logfmt fields. Stdout stays free for command output.
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFields = Record<string, string | number | boolean | undefined>;

// Values are quoted (and control characters escaped) unless they are plain, so text from the network can't break a
// line or send escape sequences to the terminal.
const formatValue = (value: string | number | boolean) =>
  typeof value === 'string' && !/^[^\s"=\p{Cc}]+$/u.test(value) ? JSON.stringify(value) : String(value);

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

const formatTime = (time: Date) =>
  `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}.${pad(time.getMilliseconds(), 3)}`;

export function formatLine(level: LogLevel, message: string, fields: LogFields, time: Date): string {
  const parts = [formatTime(time), `[${level}]`, message];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(' ');
}

let minimum = LOG_LEVELS.indexOf('info');

export function setLogLevel(level: LogLevel) {
  minimum = LOG_LEVELS.indexOf(level);
}

function write(level: LogLevel, message: string, fields: LogFields = {}) {
  if (LOG_LEVELS.indexOf(level) < minimum) return;
  process.stderr.write(`${formatLine(level, message, fields, new Date())}\n`);
}

export const log = {
  debug: (message: string, fields?: LogFields) => write('debug', message, fields),
  info: (message: string, fields?: LogFields) => write('info', message, fields),
  warn: (message: string, fields?: LogFields) => write('warn', message, fields),
  error: (message: string, fields?: LogFields) => write('error', message, fields),
};

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
