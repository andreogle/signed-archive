export function formatPrice(price: string | number) {
  const value = Number(price);
  const options = Math.abs(value) >= 1 ? { maximumFractionDigits: 4 } : { maximumSignificantDigits: 4 };
  return value.toLocaleString(undefined, options);
}

export function formatTime(seconds: number) {
  return new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

export function formatAge(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return seconds < 86_400 ? `${Math.round(seconds / 3600)}h` : `${Math.round(seconds / 86_400)}d`;
}

// datetime-local holds local time without a zone, so convert through Date both ways.
export function toLocalInput(seconds: number) {
  const date = new Date(seconds * 1000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

export function fromLocalInput(value: string) {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}
