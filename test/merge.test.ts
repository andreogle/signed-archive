import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hexToBytes } from 'viem';
import { mergeArchive } from '../src/merge.ts';
import { openReader } from '../src/reader.ts';
import { blocksize, coingecko, fixtureDb } from './fixtures.ts';

const source = fixtureDb();
const dir = mkdtempSync(join(tmpdir(), 'signed-archive-merge-'));
const target = join(dir, 'archive.sqlite');

// Rows a careless or hostile archive could hold: an edited value, an unknown signer, a bad endpoint and a broken poll.
const tampered = new Database(source.path, { strict: true });
const insert = tampered.prepare(
  `INSERT INTO datapoints (airnode, template_id, timestamp, value, signature, endpoint, fetched_at)
   VALUES ($airnode, $templateId, $timestamp, $value, $signature, $endpoint, $fetchedAt)`
);
const row = {
  airnode: hexToBytes(coingecko.airnode),
  templateId: hexToBytes(coingecko.templateId),
  timestamp: Number(coingecko.timestamp),
  value: hexToBytes(coingecko.encodedValue),
  signature: hexToBytes(coingecko.signature),
  endpoint: 'public',
  fetchedAt: 1,
};
insert.run({ ...row, value: hexToBytes(`0x${'00'.repeat(31)}01`) });
insert.run({ ...row, airnode: hexToBytes('0x0000000000000000000000000000000000000001') });
insert.run({ ...row, timestamp: row.timestamp + 1, endpoint: 'private' });
tampered.run(
  `INSERT INTO polls (airnode, endpoint, fetched_at, status, received, rejected, saved)
   VALUES (x'${coingecko.airnode.slice(2)}', 'public', 5, -1, 0, 0, 0)`
);
tampered.close();

afterAll(() => {
  source.remove();
  rmSync(dir, { recursive: true, force: true });
});

describe('mergeArchive', () => {
  test('adds verified records and polls, and rejects anything that fails the checks', async () => {
    const result = await mergeArchive({ sourcePath: source.path, dbPath: target });
    expect(result).toEqual({ read: 8, added: 5, rejected: 3, polls: 4, rejectedPolls: 1 });

    const reader = openReader(target);
    const [latest] = reader.at(
      [{ provider: 'blocksize', airnode: blocksize[0]?.airnode ?? '0x', templateId: blocksize[0]?.templateId ?? '0x' }],
      1_793_207_000
    );
    expect(latest?.signature).toBe(blocksize[1]?.signature);
    reader.close();
  });

  test('adds nothing the second time, so merging is safe to repeat', async () => {
    expect(await mergeArchive({ sourcePath: source.path, dbPath: target })).toMatchObject({ added: 0, rejected: 3 });
  });

  test('refuses to merge an archive into itself', async () => {
    await expect(mergeArchive({ sourcePath: target, dbPath: target })).rejects.toThrow('same archive');
  });
});
