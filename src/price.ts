import { formatUnits, type Hex, hexToBigInt } from 'viem';

// Pure value helpers shared by the server and the web app, which must decode prices itself rather than trust the
// server's decoded strings. Keep this module free of Bun and Node imports so it bundles for the browser.

// Values are int256 with 18 decimals, the encoding every API3 price feed uses.
const DECIMALS = 18;

export const decodeValue = (encodedValue: Hex) => hexToBigInt(encodedValue, { signed: true });
export const formatPrice = (value: bigint) => formatUnits(value, DECIMALS);
export const decodePrice = (encodedValue: Hex) => formatPrice(decodeValue(encodedValue));

// Middle value, or the mean of the two middle values for an even count, as Api3ServerV1 aggregates beacon sets.
export function median(values: readonly bigint[]): bigint | null {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) return null;
  const lower = sorted[middle - 1];
  return sorted.length % 2 === 1 || lower === undefined ? upper : (lower + upper) / 2n;
}

// One vote per provider, like a beacon set: a provider that signed two values for one moment doesn't count twice.
export function medianPrice(records: readonly { provider: string; encodedValue: Hex }[]) {
  const byProvider = new Map(records.map((record) => [record.provider, record.encodedValue]));
  const middle = median([...byProvider.values()].map(decodeValue));
  return middle === null ? null : formatPrice(middle);
}
