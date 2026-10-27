import type { Address } from 'viem';

export const BASE_URL = 'https://signed-api.api3.org';

// `public` serves base-feed data delayed by ~15 s; `public-oev` serves fresher data signed for the OEV domain.
export const ENDPOINTS = ['public', 'public-oev'] as const;
export type Endpoint = (typeof ENDPOINTS)[number];

// Airnodes that served data on the public Signed API on 2026-10-27. Taken from the addresses in
// @api3/api-integrations 22.8.0 and kept only if `/public/<airnode>` answered. The API's own
// `/airnodes` route is disabled, so new providers have to be added here by hand.
export const AIRNODES: readonly Address[] = [
  '0x25cFD221A462076a25e6df9932C7D669b455941E',
  '0x2D652E95524c4b6D09FA149F66e2168222cd27a5',
  '0x68ec391b38A66A4B19543dc031f2659e2224a781',
  '0x780e6b470bA996fA1eb6FcCfE8EB64F6208a55fa',
  '0x7fE93423D08b5e55000d7762F47f80e07A8F389c',
  '0x9dB03a07bE313B3C08261B1d1606D511f3560D9e',
  '0xB1d60a913C32a5BE249D4fFb4C0229ee20E5590B',
  '0xb43698033233427a21AA1f0863c5C2852b6C8b5E',
  '0xBA910Eb2867977A0a651FE3D2607237ff4116B1C',
  '0xc52EeA00154B4fF1EbbF8Ba39FDe37F1AC3B9Fd4',
  '0xE79B702c477127c18A0e1b47Fb008b725035c826',
];

// Feeds are re-signed every few seconds whether or not the price moved, so polling faster buys
// more rows, not better data. The floor keeps a typo in the env var from hammering the API.
const MIN_INTERVAL_SECONDS = 15;
const intervalSeconds = Number(process.env.POLL_INTERVAL_SECONDS ?? 60);
if (!Number.isFinite(intervalSeconds) || intervalSeconds < MIN_INTERVAL_SECONDS) {
  throw new Error(`POLL_INTERVAL_SECONDS must be a number >= ${MIN_INTERVAL_SECONDS}`);
}
export const POLL_INTERVAL_MS = intervalSeconds * 1000;

export const DB_PATH = process.env.DB_PATH ?? 'data/archive.sqlite';

export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_BACKOFF_MS = 30 * 60 * 1000;
export const USER_AGENT = 'signed-archive/0.1 (polite poller, one request at a time)';
