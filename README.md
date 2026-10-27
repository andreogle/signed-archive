# signed-archive

Records API3's public signed data so it has a history. The Signed API (`signed-api.api3.org`) only serves the latest
value per feed, and every record carries the provider's signature, so the archive is evidence anyone can re-check.

Each cycle fetches `/public/<airnode>` (base data, delayed ~15 s) and `/public-oev/<airnode>` for every airnode in
`src/config.ts`, checks each signature the way `Api3ServerV1` does, and stores new records in SQLite.

## Run

```sh
mise install
bun install
bun start
```

| Env var                 | Default               | Notes                                   |
| ----------------------- | --------------------- | --------------------------------------- |
| `POLL_INTERVAL_SECONDS` | `60`                  | Minimum 15. Requests are spread evenly. |
| `DB_PATH`               | `data/archive.sqlite` |                                         |

`bun run check` runs Biome, the type checker and the tests.

## Being polite

One request at a time, spread across the interval (22 requests per minute by default). Failed targets back off
exponentially up to 30 minutes and honour `Retry-After`.

## Querying

Hex fields are stored as bytes:

```sql
SELECT endpoint, hex(template_id), timestamp, hex(value) FROM datapoints ORDER BY timestamp DESC LIMIT 10;
```
