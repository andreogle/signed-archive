import { afterEach, expect, spyOn, test } from 'bun:test';
import { errorMessage, formatLine, log, setLogLevel } from '../src/logger.ts';

// Local time, so the expected prefix doesn't depend on the machine's timezone.
const time = new Date(2026, 9, 27, 4, 5, 6, 7);

afterEach(() => {
  setLogLevel('info');
});

test('prefixes local time and level, then the message and fields in order', () => {
  expect(formatLine('info', 'cycle done', { saved: 2116, rejected: 0, ok: true }, time)).toBe(
    '04:05:06.007 [info] cycle done saved=2116 rejected=0 ok=true'
  );
});

test('quotes values with spaces, quotes, equals signs or nothing at all, and drops undefined', () => {
  expect(formatLine('warn', 'x', { error: 'HTTP 503 = bad "gateway"', empty: '', skipped: undefined }, time)).toBe(
    '04:05:06.007 [warn] x error="HTTP 503 = bad \\"gateway\\"" empty=""'
  );
});

test('escapes control characters, so text from the network cannot send escape sequences to the terminal', () => {
  expect(formatLine('warn', 'x', { error: 'a\u001b[2Jb' }, time)).toBe('04:05:06.007 [warn] x error="a\\u001b[2Jb"');
});

test('writes only lines at or above the configured level, to stderr', () => {
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  setLogLevel('warn');
  log.debug('a');
  log.info('b');
  log.warn('c', { n: 1 });
  log.error('d');
  const lines = stderr.mock.calls.map(([line]) => String(line));
  stderr.mockRestore();
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/ \[warn\] c n=1\n$/);
  expect(lines[1]).toMatch(/ \[error\] d\n$/);
});

test('errorMessage reads Error messages and stringifies anything else', () => {
  expect(errorMessage(new Error('boom'))).toBe('boom');
  expect(errorMessage(42)).toBe('42');
});
