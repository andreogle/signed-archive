// Replays one feed's archived signed records through API3's real Api3ServerV1 on a local anvil chain, then checks
// after every record that the on-chain beacon set value equals the median src/price.ts computes. It shows two things:
// the archived signatures are accepted on-chain exactly as published, and the archive's median matches Median.sol.
//
//   bun run replay -- --feed ETH/USD [--from <unix s>] [--to <unix s>] [--db data/archive.sqlite] [--config <path>]
//
// The contract is deployed from @api3/contracts, whose bytecode is byte for byte what runs on Ethereum. No fork or RPC
// is needed. Replaying into a fork, to test a protocol against real history, is the next step and needs an archive
// node, because the fork must start before the replayed stretch.

import { parseArgs } from 'node:util';
import { Api3ServerV1__factory } from '@api3/contracts/dist/typechain-types/factories/api3-server-v1/Api3ServerV1__factory';
import {
  createTestClient,
  encodeAbiParameters,
  encodePacked,
  type Hex,
  http,
  keccak256,
  publicActions,
  walletActions,
} from 'viem';
import { foundry } from 'viem/chains';
import { createCatalog } from '../src/catalog.ts';
import { DEFAULT_DB_PATH } from '../src/config.ts';
import { log } from '../src/logger.ts';
import { decodeValue, median } from '../src/price.ts';
import { openReader, type SignedPrice } from '../src/reader.ts';
import { catalogInput, DEFAULT_CONFIG_PATH, parseSettings } from '../src/settings.ts';

const { values: args } = parseArgs({
  options: {
    feed: { type: 'string', default: 'ETH/USD' },
    from: { type: 'string' },
    to: { type: 'string' },
    db: { type: 'string', default: DEFAULT_DB_PATH },
    port: { type: 'string', default: '8547' },
    config: { type: 'string', default: process.env.CONFIG ?? DEFAULT_CONFIG_PATH },
  },
});

const catalog = createCatalog(catalogInput(parseSettings(await Bun.file(args.config).text())));
const sources = catalog.feeds.get(args.feed)?.public;
if (!sources) throw new Error(`unknown feed ${args.feed}`);
const reader = openReader(args.db);
const to = args.to ? Number(args.to) : Math.floor(Date.now() / 1000);
const from = args.from ? Number(args.from) : to - 10 * 60;
const records = reader.records(sources, from, to);
reader.close();
const first = records[0];
if (!first) throw new Error(`no ${args.feed} records between ${from} and ${to}`);

// A fresh chain whose clock starts just before the first record, so every record's time stamp is acceptable.
const anvil = Bun.spawn([
  'anvil',
  '--port',
  args.port,
  '--timestamp',
  String(Number(first.timestamp) - 60),
  '--silent',
]);
// anvil mines every transaction at once, so poll for receipts quickly instead of viem's default 4 s.
const client = createTestClient({
  chain: foundry,
  mode: 'anvil',
  pollingInterval: 20,
  transport: http(`http://127.0.0.1:${args.port}`),
})
  .extend(publicActions)
  .extend(walletActions);

try {
  for (let attempt = 0; ; attempt++) {
    try {
      await client.getChainId();
      break;
    } catch (error) {
      if (attempt > 50) throw error;
      await Bun.sleep(100);
    }
  }
  const [account] = await client.getAddresses();
  if (!account) throw new Error('anvil has no accounts');

  const { abi, bytecode } = Api3ServerV1__factory;
  const deployHash = await client.deployContract({
    abi,
    bytecode: bytecode as Hex,
    account,
    // The registry and manager only gate admin functions; updating and reading feeds needs neither.
    args: [account, 'Api3ServerV1 admin', account],
  });
  const server = (await client.waitForTransactionReceipt({ hash: deployHash })).contractAddress;
  if (!server) throw new Error('Api3ServerV1 deployment failed');

  const beaconIdOf = (record: SignedPrice) =>
    keccak256(encodePacked(['address', 'bytes32'], [record.airnode, record.templateId]));
  const latest = new Map<string, SignedPrice>();
  let accepted = 0;
  let rejected = 0;
  let conflicts = 0;
  let compared = 0;
  const mismatches: string[] = [];
  let clock = Number(first.timestamp) - 60;

  for (const record of records) {
    // Two values signed by one provider for the same moment. The contract keeps whichever arrives first and rejects
    // the other, so an updater can choose between them. Counted, and checked to be rejected.
    const previous = latest.get(record.provider);
    const conflict = previous?.timestamp === record.timestamp && previous.encodedValue !== record.encodedValue;
    if (conflict) conflicts += 1;
    clock = Math.max(clock + 1, Number(record.timestamp));
    await client.setNextBlockTimestamp({ timestamp: BigInt(clock) });
    try {
      const hash = await client.writeContract({
        address: server,
        abi,
        account,
        functionName: 'updateBeaconWithSignedData',
        args: [record.airnode, record.templateId, BigInt(record.timestamp), record.encodedValue, record.signature],
      });
      // A mined transaction that reverted doesn't throw, so the receipt's status decides.
      if ((await client.waitForTransactionReceipt({ hash })).status !== 'success') throw new Error('reverted');
      accepted += 1;
      latest.set(record.provider, record);
      if (conflict) mismatches.push(`${record.timestamp}: ${record.provider}'s second value was accepted`);
    } catch {
      // Not newer than the beacon's stored record, e.g. the second of two values signed for the same moment.
      rejected += 1;
      continue;
    }

    // A beacon set needs at least two beacons; take every provider seen so far, as a dAPI's beacon set would.
    const providers = [...latest.values()];
    if (providers.length < 2) continue;
    const beaconIds = providers.map(beaconIdOf);
    const beaconSetId = keccak256(encodeAbiParameters([{ type: 'bytes32[]' }], [beaconIds]));
    await client.setNextBlockTimestamp({ timestamp: BigInt(++clock) });
    const hash = await client.writeContract({
      address: server,
      abi,
      account,
      functionName: 'updateBeaconSetWithBeacons',
      args: [beaconIds],
    });
    await client.waitForTransactionReceipt({ hash });
    const [onChain] = await client.readContract({
      address: server,
      abi,
      functionName: 'dataFeeds',
      args: [beaconSetId],
    });
    const expected = median(providers.map(({ encodedValue }) => decodeValue(encodedValue)));
    compared += 1;
    if (onChain !== expected) {
      // Name the beacons whose stored value differs from the archive's latest record, to show where they diverge.
      const differing = [];
      for (const provider of providers) {
        const [value, timestamp] = await client.readContract({
          address: server,
          abi,
          functionName: 'dataFeeds',
          args: [beaconIdOf(provider)],
        });
        if (value !== decodeValue(provider.encodedValue) || timestamp !== Number(provider.timestamp)) {
          differing.push(
            `${provider.provider} on-chain ${value}@${timestamp} archive ${decodeValue(provider.encodedValue)}@${provider.timestamp}`
          );
        }
      }
      mismatches.push(
        `${record.timestamp}: on-chain ${onChain}, archive ${expected}; ${differing.join(', ') || 'every beacon matches'}`
      );
    }
  }

  log.info('replay done', {
    feed: args.feed,
    from,
    to,
    records: records.length,
    accepted,
    rejected,
    conflicts,
    providers: latest.size,
    mediansCompared: compared,
    mismatches: mismatches.length,
  });
  for (const mismatch of mismatches.slice(0, 10)) log.warn('median mismatch', { detail: mismatch });
  if (mismatches.length > 0 || accepted === 0) process.exitCode = 1;
} finally {
  anvil.kill();
}
