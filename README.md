# signed-archive

Records API3's public signed data so it has a history. The Signed API (`signed-api.api3.org`) only serves the latest
value per feed, and every record carries the provider's signature, so the archive is evidence anyone can re-check.

Each cycle fetches `/public/<airnode>` (base data, delayed ~15 s) and `/public-oev/<airnode>` for every airnode in
the config file, from two sources: API3's Signed API and the provider's own (every provider pushes the same signed
data to both). It checks each signature the way `Api3ServerV1` does and stores new records in SQLite. A record both
sources served is stored once.

## Run

```sh
mise install
bun install
bun start                      # same as: bun src/cli.ts archive
bun run serve                  # explorer at http://127.0.0.1:3000, reading the archive read-only
bun run dev                    # archiver + explorer, restarting on file changes (development only)
bun run dev -- --interval 120  # flags override env vars
```

| Flag                    | Env var                 | Default               | Notes                                    |
| ----------------------- | ----------------------- | --------------------- | ---------------------------------------- |
| `--interval <seconds>`  | `POLL_INTERVAL_SECONDS` | `60`                  | Minimum 15. Requests are spread evenly.  |
| `--db <path>`           | `DB_PATH`               | `data/archive.sqlite` |                                          |
| `--log-level <level>`   | `LOG_LEVEL`             | `info`                | `debug`, `info`, `warn` or `error`.      |
| `--serve`               | `SERVE`                 | off                   | `archive` only: also serve the explorer. |
| `--heartbeat-url <url>` | `HEARTBEAT_URL`         | none                  | `archive` only: ping after each cycle.   |
| `--host <host>`         | `HOST`                  | `127.0.0.1`           | Explorer address.                        |
| `--port <port>`         | `PORT`                  | `3000`                | Explorer port.                           |

**Config file.** One YAML file holds the settings and what to archive: `signed-archive.yaml` (committed, and shipped
in the Docker image), or any copy passed with `--config <path>` / `CONFIG`. Settings come first, then the `airnodes`
and `feeds` lists below a marker line. A flag beats an env var, which beats the file, which beats the default, and a
misspelled key is an error. Peers are set only in the file. The committed copy is public, so keep the heartbeat URL
out of it: set `HEARTBEAT_URL`, or use a private copy.

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

Feed names come from the `feeds` list in the config file. The page fetches the airnode and feed lists from
`/api/catalog` and checks every record against them in the browser.

See [IDEAS.md](IDEAS.md) for where the project could go next.

## Build

`bun run build` compiles a self-contained native binary to `dist/signed-archive` (no Bun or `node_modules` needed to
run it). The airnode list is baked in, so rebuild after updating it.

The binary is about 110 MB because it embeds the whole Bun runtime (about 107 MB); the app itself is under 100 KB.
`--bytecode` compiles the code ahead of time, which cuts startup from about 11 ms to 4 ms.

## Docker

This is the way to run the long-lived archive. `compose.yaml` runs two services from one image (the compiled binary on
a distroless base, as a non-root user):

- **archiver**: polls and writes the archive to the `archive` volume. It restarts unless stopped, stops cleanly on
  `SIGTERM`, and reports unhealthy when no request was recorded for 5 minutes (`signed-archive health`).
- **explorer**: serves the explorer from the same volume, published on `127.0.0.1:3000` (`PORT` changes the host port).

```sh
docker compose up -d --build
docker compose logs -f archiver
docker compose run --rm backup    # one consistent copy into the `backups` volume
```

Docker reports an unhealthy container but does not restart it, so add an outside alert as well: create a check on
healthchecks.io (or an Uptime Kuma push monitor) and put its URL in a `.env` file next to `compose.yaml` as
`HEARTBEAT_URL=...`. The archiver pings it after every cycle that reached the API, so the monitor alerts when pings
stop. `.env` is gitignored, since the URL is a secret.

**Backups.** `backup` writes a timestamped `VACUUM INTO` copy, which is safe while the archiver runs; never copy the
live file. Run it nightly from the host's cron and move the copies off the machine, for example:

```sh
0 3 * * * cd /path/to/signed-archive && docker compose run --rm backup
docker run --rm -v signed-archive_backups:/backups -v "$PWD":/out busybox cp -r /backups/. /out/
```

Each copy is a full archive (hundreds of MB per day of history), so prune old copies once they are stored elsewhere.

`bun run dev` stays the development loop. Don't point it at the Docker volume: under `--watch` every edit restarts the
archiver and leaves a gap.

## Fuzz tests and replay

Two dev tools check API3's own Solidity against the archive. Foundry is pinned in `mise.toml`, and `@api3/contracts`
(the contracts as deployed) is a dev dependency.

- `bun run proofs` fuzzes `Median.sol`, unchanged, in under a second: the overflow-safe average equals `(x + y) / 2`
  rounded toward zero and stays between its inputs, and the median of every length from 1 to 21 (the sorting network
  and quickselect) matches a plain sort-based reference, ignores input order and handles many equal values.
- `bun run replay -- --feed ETH/USD [--from <unix s>] [--to <unix s>]` starts a local anvil chain, deploys
  `Api3ServerV1` from `@api3/contracts` (byte for byte the bytecode on Ethereum), replays the feed's archived records
  through `updateBeaconWithSignedData` in time order, and after each one checks the beacon set value against the median
  in `src/price.ts`. It defaults to the last 10 minutes and takes a few seconds.

## Development

`bun run check` checks the airnode list is current, then runs Biome, the type checker and the tests with coverage.

## Airnodes and feeds

The `airnodes` and `feeds` lists in `signed-archive.yaml` are generated from API3's provider list in
`@api3/api-integrations` (mock providers excluded). After bumping that package, run `bun run airnodes` and commit the
result; it rewrites everything below the marker line and leaves the settings above it as they are. To archive a
different set, edit a copy of the file and pass it with `--config`; no rebuild is needed.

## Being polite

One request at a time, spread across the interval: 44 requests per minute by default, of which 22 go to
`signed-api.api3.org` and 2 to each provider's own Signed API. Failed targets back off
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

## Peer repair

A moment the archiver misses can never be fetched from the Signed API again, but another archive that was polling
then may have it. List other archives under `peers` in the config file (the base URL of their explorer). After the
first cycle, and then every 10 minutes, the archiver:

1. finds stretches of the last 7 days with no successful request for an airnode and endpoint, longer than three
   intervals, that have since ended;
2. asks each peer once per stretch, through `GET /api/records?airnode=&endpoint=&from=&to=` (windows of at most 15
   minutes, at most 10 requests per run);
3. checks every record it gets back like any other input (shape, the asked airnode, a known template on the asked
   endpoint, inside the window, valid signature) and adds the ones that pass.

A peer that answers is never asked about that stretch again: one that missed it too can never gain it later. Only
failures are retried (network errors, 429 and 5xx), three times with backoff from 5 minutes. Progress is kept in the
`repairs` table, so restarts don't repeat requests. Peers' polls are not imported, because coverage claims aren't
signed: the stretch stays a gap in `polls`, and `repairs` records what was filled and from whom.

To be someone's peer, expose your explorer (only `/api/records` is needed) where they can reach it, for example
through a reverse proxy in front of the `explorer` container.

## Querying

Hex fields are stored as bytes:

```sql
SELECT endpoint, hex(template_id), timestamp, hex(value) FROM datapoints ORDER BY timestamp DESC LIMIT 10;
-- When the archiver was not polling (fetched_at is unix milliseconds):
SELECT previous, fetched_at FROM (
  SELECT fetched_at, lag(fetched_at) OVER (ORDER BY fetched_at) AS previous FROM polls
) WHERE fetched_at - previous > 180000;
```
