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

**Config files.** Settings live in `signed-archive.yaml` (committed, and shipped in the Docker image), or any copy
passed with `--config <path>` / `CONFIG`. What to archive lives in two generated files it names under `catalog`:
`config/airnodes.yaml` and `config/feeds.yaml`, resolved relative to the settings file. A flag beats an env var, which
beats the file, which beats the default, and a misspelled key is an error. Peers are set only in the file. The
committed copy is public, so keep the heartbeat URL out of it: set `HEARTBEAT_URL`, or use a private copy.

Logs go to stderr, one line per event, with `key=value` fields:

```
14:15:23.917 [info] cycle done saved=2116 rejected=0 durationMs=59940
```

## Explorer

`serve` runs a web explorer (React, in `web/`) and a small JSON API over the archive. It opens the database read-only,
so it can run beside the archiver.

- **Feeds**: every archived feed with its current median price.
- **Explorer**: price history per provider, base or OEV data, and every provider's signed price at any moment. Each
  signature is re-checked in your browser, and "Download proof" saves the raw signed records. Until you pick a time it
  shows the latest signed prices.

The feed list, the chart and the latest prices refresh every 30 seconds while the tab is open, and each says when it
last updated.
- **API**: `/api/feeds`, `/api/history?feed=ETH/USD&from=&to=` and `/api/at?feed=ETH/USD&time=` (unix seconds; add
  `endpoint=public-oev` for OEV data).

Feed names come from `config/feeds.yaml`. The page fetches the airnode and feed lists from
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

## Development

`bun run check` checks the airnode list is current, then runs Biome, the type checker and the tests with coverage.

## Airnodes and feeds

`config/airnodes.yaml` and `config/feeds.yaml` are generated from API3's provider list in `@api3/api-integrations`
(mock providers excluded). After bumping that package, run `bun run airnodes` and commit the result; `bun run check`
fails while they are stale. To archive a different set, point `catalog.airnodes` / `catalog.feeds` in the settings file
at your own copies; no rebuild is needed.

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

## Conflicting values

The explorer's **Conflicts** page (`/conflicts`, or `/api/conflicts?from=&to=` as JSON) lists, per provider and
endpoint, the moments when a provider signed more than one value for the same feed and second: how many (and out of
how many archived moments), how far apart the values were in basis points (median, 90th percentile, widest), and which
Signed APIs served each side, matched through the poll that saved each record. Each provider's widest conflict links to
the feed at that second, where both signed values are shown and checked in the browser. Counting scans every record in
the range, so the page refreshes every 5 minutes rather than every 30 seconds.

The rate is a lower bound. Each host is polled about once a minute, so a conflict only shows when both copies happen
to be serving a record from the same second.

## Peer repair

A moment the archiver misses can never be fetched from the Signed API again, but another archive that was polling
then may have it. List other archives under `peers` in the config file (the base URL of their explorer). Repair runs
beside polling, never inside it, so a slow or unreachable peer can't hold up archiving:

1. After the first polling cycle, then every 10 minutes, it finds gaps that have closed: stretches with no successful
   request for an airnode and endpoint longer than three polling intervals, and never shorter than 3 minutes. A gap
   that ended in the last week is found whole, however long ago it started.
2. Each gap is split once into windows of at most 15 minutes, with 2 minutes of margin on both sides for signing
   delays and clock drift, and each window is recorded for each peer in `repair_windows`.
3. Due windows are asked one every 5 seconds, newest first, through
   `GET /api/records?airnode=&endpoint=&from=&to=`. A window another peer already covered is skipped.
4. Every record that comes back is checked like any other input (shape, the asked airnode and window, a known
   template, valid signature) and added if it passes. Responses over 16 MB or 50,000 records, and redirects, are
   refused; duplicates are dropped before the signature check.

A peer also says where in the window it has nothing itself (`uncovered`). A peer that watched the whole window and
has nothing is final: it can never gain the data later. A window the peer missed part of is asked once more an hour
later, since the peer may have filled it from its own peers. Network errors, 429 and other non-400 errors are retried
up to three times with backoff, honouring `Retry-After`; a peer that keeps failing is paused as a whole (from 5
minutes up to 6 hours), so its outage doesn't use up the attempts of every window waiting on it. Peers' polls are
never imported, because coverage claims aren't signed: the stretch stays a gap in `polls`, and `peer_coverage` records
the stretches the peer's records actually span. The explorer shades a stretch until every provider of the feed is
covered.

Nodes may poll at different intervals, run different versions or list different feeds. Records prove themselves, so
none of that matters to what is exchanged: a peer returns whatever it holds in the window, and records under templates
this archive doesn't know are skipped (and counted) rather than treated as suspicious. An archive that doesn't send
`uncovered` is read through its `watched` flag.

Known cost: merging polls into an old gap changes where the gap starts, so its pieces are asked about again (windows
already covered are skipped).

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
