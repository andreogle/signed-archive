// Helpers for reading responses from hosts this archive doesn't control: the Signed APIs and peers.

// Retry-After in seconds or as an HTTP date, in milliseconds from `now`; anything else is ignored.
export function retryAfterMs(header: string | null, now: number) {
  if (header === null) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

// The body as text, or null when it is over `maxBytes`, however it is sent.
export async function readCapped(response: Response, maxBytes: number) {
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
