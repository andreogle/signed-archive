import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hexToBytes } from 'viem';
import type { Endpoint } from './config.ts';
import type { SignedDatum } from './signed-data.ts';

// Hex fields are stored as bytes (about half the size); read them back with SQL `hex()`.
// The key includes the value, so two different values signed for the same feed and timestamp
// both land as separate rows. That pair is the equivocation evidence the archive exists to catch.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS datapoints (
    airnode     BLOB    NOT NULL,
    template_id BLOB    NOT NULL,
    timestamp   INTEGER NOT NULL,
    value       BLOB    NOT NULL,
    signature   BLOB    NOT NULL,
    endpoint    TEXT    NOT NULL,
    fetched_at  INTEGER NOT NULL,
    PRIMARY KEY (airnode, template_id, timestamp, value)
  ) WITHOUT ROWID
`;

export function openStore(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run('PRAGMA journal_mode = WAL');
  db.run(SCHEMA);

  const insert = db.prepare(
    `INSERT OR IGNORE INTO datapoints (airnode, template_id, timestamp, value, signature, endpoint, fetched_at)
     VALUES ($airnode, $templateId, $timestamp, $value, $signature, $endpoint, $fetchedAt)`
  );

  const save = db.transaction((data: SignedDatum[], endpoint: Endpoint, fetchedAt: number) => {
    let inserted = 0;
    for (const datum of data) {
      inserted += insert.run({
        airnode: hexToBytes(datum.airnode),
        templateId: hexToBytes(datum.templateId),
        timestamp: Number(datum.timestamp),
        value: hexToBytes(datum.encodedValue),
        signature: hexToBytes(datum.signature),
        endpoint,
        fetchedAt,
      }).changes;
    }
    return inserted;
  });

  return { save, close: () => db.close() };
}
