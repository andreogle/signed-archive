import { expect, test } from 'bun:test';
import { err, type GoOptions, go, goSync, isErr, isOk, ok, TimeoutError } from '../src/result.ts';

test('tuples carry either an error or a value', () => {
  const results = [ok(1), err(new Error('no'))];
  expect(results.filter(isOk)).toEqual([[undefined, 1]]);
  expect(results.filter(isErr).map(([error]) => error.message)).toEqual(['no']);
});

test('goSync and go capture throws and rejections, keeping Error instances', async () => {
  const thrown = new RangeError('bad');
  expect(goSync(() => 2)).toEqual([undefined, 2]);
  expect(
    goSync(() => {
      throw thrown;
    })[0]
  ).toBe(thrown);
  expect(await go(async () => 3)).toEqual([undefined, 3]);
  expect((await go(() => Promise.reject(thrown)))[0]).toBe(thrown);
  // A thrown non-Error becomes an Error that keeps the original value as its cause.
  const [wrapped] = goSync(() => {
    throw 'text';
  });
  expect(wrapped?.message).toBe('text');
  expect(wrapped?.cause).toBe('text');
  const unprintable = {
    toString: () => {
      throw new Error('no string');
    },
  };
  const [fallback] = await go(() => {
    throw unprintable;
  });
  expect(fallback?.message).toBe('Non-Error value thrown');
});

test('go retries only when approved, with a delay', async () => {
  let calls = 0;
  const flaky = () => {
    calls += 1;
    if (calls < 3) throw new Error(`attempt ${calls}`);
    return calls;
  };
  expect(await go(flaky, { attempts: 3, shouldRetry: () => true, delayMs: ({ attempt }) => attempt })).toEqual([
    undefined,
    3,
  ]);
  calls = 0;
  expect((await go(flaky, { attempts: 3 }))[0]?.message).toBe('attempt 1');
  calls = 0;
  expect((await go(flaky, { attempts: 3, shouldRetry: () => false }))[0]?.message).toBe('attempt 1');
  calls = 0;
  expect((await go(flaky, { attempts: 2, shouldRetry: () => true, delayMs: 0 }))[0]?.message).toBe('attempt 2');
  calls = 0;
  const policy = new Error('policy');
  const [policyError] = await go(flaky, {
    attempts: 3,
    shouldRetry: () => {
      throw policy;
    },
  });
  expect(policyError).toBe(policy);
  calls = 0;
  expect((await go(flaky, { attempts: 3, shouldRetry: () => true, delayMs: () => -1 }))[0]).toBeInstanceOf(RangeError);
});

test('go times out attempts and stops on cancellation', async () => {
  const [timedOut] = await go(() => new Promise(() => undefined), { timeoutMs: 5 });
  expect(timedOut).toBeInstanceOf(TimeoutError);
  expect(timedOut).toMatchObject({ attempt: 1, timeoutMs: 5 });
  const reason = new Error('stopped');
  expect((await go(() => 1, { signal: AbortSignal.abort(reason) }))[0]).toBe(reason);
  // The operation sees the signal, and a cancellation during a retry delay ends the retries.
  const stop = new AbortController();
  const seen: AbortSignal[] = [];
  const [cancelled] = await go(
    ({ signal }) => {
      seen.push(signal);
      setTimeout(() => stop.abort(reason), 5);
      throw new Error('fails');
    },
    { attempts: 5, shouldRetry: () => true, delayMs: 1000, signal: stop.signal }
  );
  expect(cancelled).toBe(reason);
  expect(seen).toHaveLength(1);
  // Cancelling mid-attempt rejects at once, and a pending retry decision loses to cancellation too.
  const during = new AbortController();
  setTimeout(() => during.abort(reason), 5);
  expect((await go(() => new Promise(() => undefined), { signal: during.signal }))[0]).toBe(reason);
  const deciding = new AbortController();
  const [undecided] = await go(
    () => {
      throw new Error('fails');
    },
    {
      attempts: 2,
      signal: deciding.signal,
      shouldRetry: () => {
        setTimeout(() => deciding.abort(reason), 5);
        return new Promise<boolean>(() => undefined);
      },
    }
  );
  expect(undecided).toBe(reason);
});

test('go rejects bad options as a failed result before running', async () => {
  let ran = false;
  const run = () => {
    ran = true;
  };
  for (const options of [
    { attempts: 0 },
    { timeoutMs: 0 },
    { delayMs: Number.NaN },
    { delayMs: 'soon' },
    { shouldRetry: true },
    { signal: {} },
    null,
  ]) {
    // The checks exist for callers outside TypeScript.
    const [error] = await go(run, options as unknown as GoOptions);
    expect(error).toBeInstanceOf(Error);
  }
  expect(ran).toBe(false);
});
