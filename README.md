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
bun run dev -- --help          # run the CLI from source, restarting on file changes
bun run dev -- --interval 120  # flags override env vars
```

| Flag                   | Env var                 | Default               | Notes                                   |
| ---------------------- | ----------------------- | --------------------- | --------------------------------------- |
| `--interval <seconds>` | `POLL_INTERVAL_SECONDS` | `60`                  | Minimum 15. Requests are spread evenly. |
| `--db <path>`          | `DB_PATH`               | `data/archive.sqlite` |                                         |
| `--log-level <level>`  | `LOG_LEVEL`             | `info`                | `debug`, `info`, `warn` or `error`.     |

Logs go to stderr, one line per event, with `key=value` fields:

```
14:15:23.917 [info] cycle done saved=2116 rejected=0 durationMs=59940
```

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

## Querying

Hex fields are stored as bytes:

```sql
SELECT endpoint, hex(template_id), timestamp, hex(value) FROM datapoints ORDER BY timestamp DESC LIMIT 10;
```
