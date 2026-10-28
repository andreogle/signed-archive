# signed-archive

Records API3's public signed data so it has a history. The Signed API (`signed-api.api3.org`) only serves the latest
value per feed, and every record carries the provider's signature, so the archive is evidence anyone can re-check.

Each cycle fetches `/public/<airnode>` (base data, delayed ~15 s) and `/public-oev/<airnode>` for every airnode in
`src/airnodes.json`, checks each signature the way `Api3ServerV1` does, and stores new records in SQLite.

## Run

```sh
mise install
bun install
bun start                      # same as: bun src/cli.ts archive
bun run serve                  # explorer at http://127.0.0.1:3000, reading the archive read-only
bun run dev                    # archiver + explorer, restarting on file changes (development only)
bun run dev -- --interval 120  # flags override env vars
```

| Flag                   | Env var                 | Default               | Notes                                    |
| ---------------------- | ----------------------- | --------------------- | ---------------------------------------- |
| `--interval <seconds>` | `POLL_INTERVAL_SECONDS` | `60`                  | Minimum 15. Requests are spread evenly.  |
| `--db <path>`          | `DB_PATH`               | `data/archive.sqlite` |                                          |
| `--log-level <level>`  | `LOG_LEVEL`             | `info`                | `debug`, `info`, `warn` or `error`.      |
| `--serve`              | `SERVE`                 | off                   | `archive` only: also serve the explorer. |
| `--host <host>`        | `HOST`                  | `127.0.0.1`           | Explorer address.                        |
| `--port <port>`        | `PORT`                  | `3000`                | Explorer port.                           |

Logs go to stderr, one line per event, with `key=value` fields:

```
14:15:23.917 [info] cycle done saved=2116 rejected=0 durationMs=59940
```

## Explorer

`serve` runs a web explorer (React, in `web/`) and a small JSON API over the archive. It opens the database read-only,
so it can run beside the archiver.

- **Feeds**: every archived feed with its current median price.
- **Explorer**: price history per provider, base or OEV data, and every provider's signed price at any moment. Each
  signature is re-checked in your browser, and "Download proof" saves the raw signed records.
- **API**: `/api/feeds`, `/api/history?feed=ETH/USD&from=&to=` and `/api/at?feed=ETH/USD&time=` (unix seconds; add
  `endpoint=public-oev` for OEV data).

Feed names come from `src/feeds.json`, generated with the airnode list by `bun run airnodes`.

See [IDEAS.md](IDEAS.md) for where the project could go next.

## Build

`bun run build` compiles a self-contained native binary to `dist/signed-archive` (no Bun or `node_modules` needed to
run it). The airnode list is baked in, so rebuild after updating it.

The binary is about 110 MB because it embeds the whole Bun runtime (about 107 MB); the app itself is under 100 KB.
`--bytecode` compiles the code ahead of time, which cuts startup from about 11 ms to 4 ms.

## Development

`bun run check` checks the airnode list is current, then runs Biome, the type checker and the tests with coverage.

## Airnodes

`src/airnodes.json` lists the providers to archive. It is generated from API3's provider list in
`@api3/api-integrations` (mock providers excluded). After bumping that package, run `bun run airnodes` and commit the
result.

## Being polite

One request at a time, spread across the interval (22 requests per minute by default). Failed targets back off
exponentially up to 30 minutes and honour `Retry-After`.

## Coverage and redundancy

The Signed API only serves the latest value, so a moment the archiver misses is gone. Two things help:

- **Coverage log.** Every request, failed or not, adds a row to `polls`. A stretch with no polls means the archiver was
  down; a failed status means the provider was. The explorer shades the gaps and doesn't draw lines across them.
- **Merging.** Run more than one archiver and merge their archives. Copy the other archive with SQLite's backup first,
  never by copying the live file:

  ```sh
  sqlite3 other/archive.sqlite "VACUUM INTO 'other-copy.sqlite'"
  bun src/cli.ts merge other-copy.sqlite        # into data/archive.sqlite, or --db <path>
  ```

  Every record is checked as if it came from the network (shape, known airnode, signature) and only added, never
  overwritten. Records the target already has are skipped, so merging again is fast. Polls are merged too; they are
  the other archiver's unsigned claim of when it was watching, so only merge archives you run or trust.

## Querying

Hex fields are stored as bytes:

```sql
SELECT endpoint, hex(template_id), timestamp, hex(value) FROM datapoints ORDER BY timestamp DESC LIMIT 10;
-- When the archiver was not polling (fetched_at is unix milliseconds):
SELECT previous, fetched_at FROM (
  SELECT fetched_at, lag(fetched_at) OVER (ORDER BY fetched_at) AS previous FROM polls
) WHERE fetched_at - previous > 180000;
```
