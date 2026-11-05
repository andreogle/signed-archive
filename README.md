# signed-archive

signed-archive keeps a history of API3's public signed price data.

API3's Signed API (`signed-api.api3.org`) serves only the latest value of each feed. signed-archive polls it and
stores every new record in SQLite. Each record carries the provider's signature, so anyone can check that the archive
is genuine. You don't have to trust whoever runs it.

With the archive you can:

- see what each provider signed at any past moment, and download the proof
- find moments when a provider signed two different values for the same feed and second
- give AI agents verified prices through MCP

## Contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Run with Docker](#run-with-docker)
- [Configuration](#configuration)
- [Explorer and API](#explorer-and-api)
- [MCP for AI agents](#mcp-for-ai-agents)
- [Catalogue updates](#catalogue-updates)
- [Filling gaps](#filling-gaps)
- [Conflicting values](#conflicting-values)
- [Parquet files](#parquet-files)
- [Querying the database](#querying-the-database)
- [Development](#development)

## How it works

Every cycle, the archiver asks for each provider's latest records on two endpoints:

- `/public/<airnode>`: base data, about 15 seconds old
- `/public-oev/<airnode>`: fresher data, signed under the OEV template ID

It asks two hosts for each: API3's Signed API and the provider's own Signed API. Both serve the same signed data, so
a record seen on both is stored once.

Each signature is checked the same way the `Api3ServerV1` contract checks it. Records that fail are counted and
dropped. Records that pass are stored exactly as signed.

The archiver is polite to the API:

- It sends one request at a time, spread evenly across the poll interval. By default that is 44 requests a minute:
  22 to `signed-api.api3.org` and 2 to each provider's own API.
- A host that fails waits before it is tried again. The wait doubles each time, up to 30 minutes, and follows
  `Retry-After`.

## Quick start

Install the tools and dependencies:

```sh
mise install
bun install
```

Start the archiver. It writes to `data/archive.sqlite`:

```sh
bun start
```

In another terminal, start the explorer. Then open http://127.0.0.1:3000:

```sh
bun run serve
```

The explorer opens the database read-only, so it can run beside the archiver.

> [!WARNING]
> A moment the archiver misses can't be fetched again later. Use `bun start` or Docker for an archive you keep.
> `bun run dev` restarts on every file change, and each restart leaves a gap.

## Run with Docker

Docker is the recommended way to run an archive long-term. `compose.yaml` runs two services from one image:

- **archiver** polls the API and writes to the `archive` volume. It restarts unless you stop it.
- **explorer** serves the explorer from the same volume on `127.0.0.1:3000`. Set `PORT` to change the host port.

```sh
docker compose up -d --build
docker compose logs -f archiver
```

### Monitoring

Docker marks the archiver unhealthy when it records no request for 5 minutes. Docker does not restart it, so add an
outside alert too:

1. Create a check on healthchecks.io, or a push monitor in Uptime Kuma.
2. Put its URL in a `.env` file next to `compose.yaml`: `HEARTBEAT_URL=https://...`

The archiver pings the URL after every cycle that reached the API. The monitor alerts you when the pings stop.
`.env` is gitignored, because the URL is a secret.

### Backups

Make a consistent copy into the `backups` volume. This is safe while the archiver runs:

```sh
docker compose run --rm backup
```

Never copy the live database file. Run the backup nightly and move the copies off the machine:

```sh
# crontab
0 3 * * * cd /path/to/signed-archive && docker compose run --rm backup

# copy the backups to the current directory
docker run --rm -v signed-archive_backups:/backups -v "$PWD":/out busybox cp -r /backups/. /out/
```

Each backup has two parts:

- a SQLite copy with recent records (about the last week)
- a `parquet/` folder with every older day (see [Parquet files](#parquet-files))

You can delete old SQLite copies once they are stored elsewhere. Keep `parquet/`.

## Configuration

Settings come from four places. Each one overrides the ones below it:

1. command-line flags
2. environment variables
3. the settings file, `signed-archive.yaml` (or the file given with `--config` / `CONFIG`)
4. built-in defaults

| Flag                          | Env var                 | Default               | Notes                                           |
| ----------------------------- | ----------------------- | --------------------- | ----------------------------------------------- |
| `--interval <seconds>`        | `POLL_INTERVAL_SECONDS` | `60`                  | Minimum 15.                                     |
| `--db <path>`                 | `DB_PATH`               | `data/archive.sqlite` |                                                 |
| `--log-level <level>`         | `LOG_LEVEL`             | `info`                | `debug`, `info`, `warn` or `error`.             |
| `--serve [on]`                | `SERVE`                 | off                   | `archive` only. Also serve the explorer.        |
| `--heartbeat-url <url>`       | `HEARTBEAT_URL`         | none                  | `archive` only. Ping this URL after each cycle. |
| `--catalog-auto-update [on]`  | `CATALOG_AUTO_UPDATE`   | on (shipped config)   | See [Catalogue updates](#catalogue-updates).    |
| `--parquet-after-days <days>` | `PARQUET_AFTER_DAYS`    | `7`                   | See [Parquet files](#parquet-files).            |
| `--parquet-dir <path>`        | `PARQUET_DIR`           | `parquet/` by the db  |                                                 |
| `--host <host>`               | `HOST`                  | `127.0.0.1`           | Explorer address.                               |
| `--port <port>`               | `PORT`                  | `3000`                | Explorer port.                                  |

Some rules for the settings file:

- Paths in the file are relative to the file. Paths in flags and env vars are relative to the working directory.
- A misspelled key is an error.
- Peers can be set only in the file. See [Filling gaps](#filling-gaps).
- The committed file is public. Keep the heartbeat URL out of it: use `HEARTBEAT_URL` or a private copy.

Logs go to stderr, one line per event:

```
14:15:23.917 [info] cycle done saved=2116 rejected=0 durationMs=59940
```

## Explorer and API

`bun run serve` (or `archive --serve`) starts a web explorer and a JSON API. The explorer has three pages:

- **Feeds**: every archived feed with its current median price.
- **Explorer**: price history per provider, and every provider's signed price at any moment. Your browser re-checks
  each signature. "Download proof" saves the raw signed records.
- **Conflicts**: values signed twice for the same moment. See [Conflicting values](#conflicting-values).

The feed list, chart and latest prices refresh every 30 seconds.

The API uses unix seconds. Add `endpoint=public-oev` for OEV data.

| Route                                 | Returns                                             |
| ------------------------------------- | --------------------------------------------------- |
| `/api/feeds`                          | every feed with its current median                  |
| `/api/history?feed=ETH/USD&from=&to=` | price history per provider                          |
| `/api/at?feed=ETH/USD&time=`          | every provider's signed price at a moment           |
| `/api/conflicts?from=&to=`            | conflicting values, for at most 7 days              |
| `/api/catalog`                        | the providers and feeds the explorer checks against |
| `/data/manifest.json`, `/data/<name>` | the Parquet files and their SHA-256                 |

See [IDEAS.md](IDEAS.md) for where the project could go next.

## MCP for AI agents

The archive is also a read-only MCP server. An agent can ask for signed prices and gets the proof with each answer.

| Tool                | What it does                                                                       |
| ------------------- | ---------------------------------------------------------------------------------- |
| `list_feeds`        | Lists feeds with their current median. Filter by name.                             |
| `get_price_at`      | Each provider's signed price at a moment, with the median and raw signed fields.   |
| `check_price`       | Says whether the latest price is safe to use: fresh, agreed and without conflicts. |
| `get_price_history` | Price points per provider over a range, and the stretches with no data.            |
| `get_conflicts`     | Values signed twice for the same second, per provider.                             |

Connect locally, over stdin and stdout:

```sh
claude mcp add signed-archive -- /path/to/signed-archive mcp --config /path/to/signed-archive.yaml
```

Or connect to a running explorer over HTTP:

```sh
claude mcp add --transport http signed-archive http://127.0.0.1:3000/mcp
```

`POST /mcp` serves agents, which send no `Origin` header. It serves browser pages only from `localhost` or
`127.0.0.1`, so a website you visit can't call the tools.

## Catalogue updates

The catalogue is the list of providers and feeds to archive. A new archive starts from two generated files:
`config/airnodes.yaml` and `config/feeds.yaml`.

The shipped config turns on `catalog.autoUpdate`. With it on, the archiver checks
[API3's published integration data](https://github.com/api3dao/api-integrations-data) at startup and then hourly:

- It reads every provider file from one Git revision and checks the whole set before using it.
- A bad or incomplete update is ignored. The last good catalogue stays in use.
- New providers are polled from the next cycle. Removed providers are no longer polled.
- Each accepted catalogue is saved in SQLite, so restarts, backups, the explorer, MCP and peer repair all use it.
- Old providers and feeds stay known, so their records can still be found and checked.

This trusts API3's repository for provider names and feed names. Every signed record is still checked on its own.

To archive your own set of providers or feeds:

1. Set `catalog.autoUpdate: false` (or `CATALOG_AUTO_UPDATE=false`).
2. Point `catalog.airnodes` and `catalog.feeds` at your own files.

To regenerate the shipped files after bumping `@api3/api-integrations`, run `bun run airnodes` and commit the result.
`bun run check` fails while they are out of date.

## Filling gaps

The Signed API serves only the latest value, so a moment the archiver misses is gone from the API. Three things
help.

**The coverage log.** Every request writes a row to `polls`, even when it fails. No polls means the archiver was
down. A failed status means the provider was down. The explorer shades the gaps.

**Merging.** Run more than one archiver and merge their archives. Copy the other archive with SQLite's backup first:

```sh
sqlite3 other/archive.sqlite "VACUUM INTO 'other-copy.sqlite'"
bun src/cli.ts merge other-copy.sqlite        # into data/archive.sqlite, or use --db <path>
```

Each record is checked as if it came from the network, and records are only added, never overwritten. The other
archive's polls are merged too. Polls are not signed, so merge only archives you run or trust. `merge` reads only the
other archive's SQLite, not its Parquet files.

**Peer repair.** List other archives under `peers` in the settings file, by the base URL of their explorer. The
archiver then asks them for records it missed:

- Every 10 minutes it looks for gaps that have closed. A gap is a stretch longer than three poll intervals, and at
  least 3 minutes, with no successful request.
- It splits each gap into windows of up to 15 minutes. It asks peers for one window every 5 seconds, newest first.
- Every record a peer returns is checked like any other input. Oversized answers and redirects are refused.
- Failed requests are retried up to three times. A peer that keeps failing is paused for 5 minutes to 6 hours.
- A peer's polls are never copied. Only what its signed records cover counts as filled.

Repair runs beside polling, so a slow peer never holds up archiving. Peers can run different versions, intervals or
feed lists. Records under feeds this archive doesn't know are skipped.

To be someone's peer, make your explorer's `/api/records` route reachable to them, for example through a reverse
proxy.

## Conflicting values

Sometimes a provider signs two different values for the same feed and second. The archive keeps both, because that
pair is evidence.

The **Conflicts** page (`/conflicts`) shows, per provider and endpoint:

- how many moments had more than one value, out of how many archived
- how far apart the values were, in basis points
- which Signed API served each value

Each provider's widest conflict links to the feed at that second, with both values checked in your browser. The page
refreshes every 5 minutes, because counting reads every record in the range.

The count is a lower bound. Each host is polled about once a minute, so a conflict shows only when both values happen
to be served at polling time.

## Parquet files

Once a day is 7 days old, the archiver moves its records from SQLite into Parquet files in `parquet/` next to the
database. Parquet takes about a third of the space.

A day is moved only after its file is written, read back and matched against SQLite row for row. Only then are those
rows deleted from SQLite. Files are never changed. A record that arrives later for a moved day goes into a new file
for that day.

The explorer, API and MCP read SQLite and Parquet together, so nothing changes for them.

Each day is one or more files named `YYYY-MM-DD.NNN.parquet`. Every field is kept exactly as signed:

| Column        | Type           | Notes                                                  |
| ------------- | -------------- | ------------------------------------------------------ |
| `airnode`     | 20 bytes       |                                                        |
| `template_id` | 32 bytes       | OEV records carry the OEV template ID                  |
| `timestamp`   | int64          | unix seconds, as signed                                |
| `value`       | 32 bytes       | int256, 18 decimals                                    |
| `signature`   | 65 bytes       |                                                        |
| `endpoint`    | string         | `public` or `public-oev`                               |
| `fetched_at`  | int64          | unix milliseconds, when this archive fetched it        |
| `source`      | string or null | `api3` or `provider`; null for merged or repaired ones |

Download the files from `/data/`, or query one in place with DuckDB. DuckDB reads only the parts it needs. Take file
names from `/data/manifest.json`, because a URL can't be a glob:

```sql
SELECT '0x' || lower(hex(airnode)) AS airnode, count(*) AS records
FROM read_parquet('https://archive.example.org/data/2026-11-02.000.parquet')
GROUP BY ALL;
```

To read recent days too, combine the files with SQLite. DuckDB can't scan `datapoints` directly, so pass the query
through to SQLite:

```sql
ATTACH 'data/archive.sqlite' AS live (TYPE sqlite, READ_ONLY);
SELECT count(*) FROM (
  SELECT hex(airnode), hex(template_id), timestamp, hex(value) FROM read_parquet('data/parquet/*.parquet')
  UNION
  SELECT * FROM sqlite_query('live', 'SELECT hex(airnode), hex(template_id), timestamp, hex(value) FROM datapoints')
);
```

## Querying the database

Hex fields are stored as bytes. Read them with `hex()`:

```sql
SELECT endpoint, hex(template_id), timestamp, hex(value) FROM datapoints ORDER BY timestamp DESC LIMIT 10;
```

Find when the archiver was not polling. `fetched_at` is in unix milliseconds:

```sql
SELECT previous, fetched_at FROM (
  SELECT fetched_at, lag(fetched_at) OVER (ORDER BY fetched_at) AS previous FROM polls
) WHERE fetched_at - previous > 180000;
```

## Development

| Command         | What it does                                                   |
| --------------- | -------------------------------------------------------------- |
| `bun run dev`   | Runs the archiver and explorer, restarting on file changes.    |
| `bun run check` | Checks the airnode list, then runs Biome, `tsc` and the tests. |
| `bun run build` | Compiles a native binary to `dist/signed-archive`.             |

The binary needs no Bun or `node_modules`. It reads the airnode and feed lists from `config/` at run time, so updating
them needs no rebuild. It is about 110 MB, almost all of it the embedded Bun runtime.

Never point `bun run dev` at the Docker volume. Every restart leaves a gap in the history.
