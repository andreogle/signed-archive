import { Database } from 'bun:sqlite';
import { existsSync, realpathSync } from 'node:fs';
import { AIRNODES, isEndpoint } from './config.ts';
import { log } from './logger.ts';
import { hasValidSignature, toSignedDatum } from './signed-data.ts';
import { openStore, type StoredPoll, type StoredRecord } from './store.ts';

const BATCH_SIZE = 1000;
const PROGRESS_EVERY = 100_000;
const KNOWN_AIRNODES = new Set(AIRNODES.map(({ airnode }) => airnode.toLowerCase()));

// The other archive is untrusted: every column is checked as if it came from the network.
interface SourceRow {
  airnode: unknown;
  templateId: unknown;
  timestamp: unknown;
  value: unknown;
  signature: unknown;
  endpoint: unknown;
  fetchedAt: unknown;
}
interface SourcePoll {
  airnode: unknown;
  endpoint: unknown;
  fetchedAt: unknown;
  status: unknown;
  received: unknown;
  rejected: unknown;
  saved: unknown;
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const hex = (value: unknown) => (typeof value === 'string' ? `0x${value.toLowerCase()}` : null);

type Store = ReturnType<typeof openStore>;

// A record, `'present'` when the target already has it, or null when it fails a check.
async function toRecord(row: SourceRow, store: Store): Promise<StoredRecord | 'present' | null> {
  const datum = toSignedDatum({
    airnode: hex(row.airnode),
    templateId: hex(row.templateId),
    timestamp: typeof row.timestamp === 'number' ? String(row.timestamp) : null,
    encodedValue: hex(row.value),
    signature: hex(row.signature),
  });
  if (!datum || !KNOWN_AIRNODES.has(datum.airnode) || !isEndpoint(row.endpoint) || !isCount(row.fetchedAt)) {
    return null;
  }
  // Recovering a signer is the slow step, so records the target already holds are not checked again.
  if (store.has(datum)) return 'present';
  return (await hasValidSignature(datum)) ? { datum, endpoint: row.endpoint, fetchedAt: row.fetchedAt } : null;
}

// Polls aren't signed: they are the other archiver's claim of when it was watching. They are merged
// so its coverage fills our gaps, which is why only archives you run or trust should be merged.
function toPoll(row: SourcePoll): StoredPoll | null {
  const airnode = hex(row.airnode);
  const statusOk = row.status === null || isCount(row.status);
  if (!airnode || !KNOWN_AIRNODES.has(airnode) || !isEndpoint(row.endpoint) || !isCount(row.fetchedAt) || !statusOk) {
    return null;
  }
  if (!isCount(row.received) || !isCount(row.rejected) || !isCount(row.saved)) return null;
  return {
    airnode: airnode as StoredPoll['airnode'],
    endpoint: row.endpoint,
    fetchedAt: row.fetchedAt,
    status: row.status as number | null,
    received: row.received,
    rejected: row.rejected,
    saved: row.saved,
  };
}

// Copies every record from another archive that passes the archiver's own checks into this one. Rows are only
// added, never replaced, so a value that differs from ours for the same feed and time is kept beside it.
export async function mergeArchive({ sourcePath, dbPath }: { sourcePath: string; dbPath: string }) {
  if (existsSync(dbPath) && realpathSync(sourcePath) === realpathSync(dbPath)) {
    throw new Error('source and target are the same archive');
  }
  const source = new Database(sourcePath, { readonly: true, strict: true });
  const store = openStore(dbPath);
  let read = 0;
  let added = 0;
  let rejected = 0;
  let pending: StoredRecord[] = [];

  try {
    const rows = source.query<SourceRow, []>(
      `SELECT hex(airnode) AS airnode, hex(template_id) AS templateId, timestamp, hex(value) AS value,
              hex(signature) AS signature, endpoint, fetched_at AS fetchedAt FROM datapoints`
    );
    for (const row of rows.iterate()) {
      read += 1;
      const record = await toRecord(row, store);
      if (record === null) rejected += 1;
      else if (record !== 'present') pending.push(record);
      if (pending.length >= BATCH_SIZE) {
        added += store.add(pending, []);
        pending = [];
      }
      if (read % PROGRESS_EVERY === 0) log.info('merge progress', { read, added, rejected });
    }
    added += store.add(pending, []);

    const hasPolls = source.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'polls'").get();
    const polls = hasPolls
      ? source
          .query<SourcePoll, []>(
            `SELECT hex(airnode) AS airnode, endpoint, fetched_at AS fetchedAt, status, received, rejected, saved
             FROM polls`
          )
          .all()
          .map(toPoll)
      : [];
    const validPolls = polls.filter((poll) => poll !== null);
    store.add([], validPolls);
    return { read, added, rejected, polls: validPolls.length, rejectedPolls: polls.length - validPolls.length };
  } finally {
    source.close();
    store.close();
  }
}
