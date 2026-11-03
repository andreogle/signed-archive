import { expect, test } from 'bun:test';
import { readCapped } from '../src/http.ts';

test('cancels oversized response bodies, whether declared or discovered while streaming', async () => {
  for (const headers of [new Headers({ 'content-length': '100' }), new Headers()]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(await readCapped(new Response(body, { headers }), 10)).toBeNull();
    expect(cancelled).toBe(true);
  }
});
