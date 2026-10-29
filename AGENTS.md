# signed-archive - Bun + TypeScript

signed-archive records API3's public signed data (`signed-api.api3.org`) into SQLite, so it has a history. The Signed API only serves the latest value per feed. Every record carries the provider's signature, so the archive is evidence anyone can re-check, not data people have to trust us for.

This file holds what is specific to this project and the invariants that must never be missed. `CLAUDE.md` is a symlink to it - edit this file, never the link. Keep it short: a rule earns its place by preventing a real mistake.

## Critical invariants (never skip)

**The archive is evidence**
- Store records exactly as signed: `airnode`, `templateId`, `timestamp`, `encodedValue`, `signature`. Never normalise, round or re-encode a signed field, or the signature stops verifying
- Only store a record whose signature recovers to the airnode it was fetched for (`hasValidSignature` in `src/signed-data.ts`, the same EIP-191 check `Api3ServerV1` does). Count and log anything else as rejected
- The primary key includes the value, so two different values signed for the same feed and timestamp both survive. That pair is the equivocation evidence the archive exists to catch: never "fix" it with an upsert or a key without the value
- Never delete or rewrite stored rows. A schema change adds a table or column; it never migrates signed data in place
- Hex fields are stored as bytes. Read them with SQL `hex()` and write them with `hexToBytes`
- Every request writes a `polls` row in the same transaction as its records, failures included, with the `source` that answered (`api3` or the provider's own Signed API). Without it a gap in the history is indistinguishable from a provider that stopped signing
- Another archive is untrusted input: `merge` and peer repair (`src/repair.ts`) re-check shape, known airnode and signature for every record before adding it, exactly as the archiver does. Repair also requires the asked airnode, a known template on the asked endpoint and the asked window. Never add a fast path that copies rows unverified, and never import a peer's polls as our own coverage
- A stretch a peer filled is shown as normal history: `gaps()` leaves out what `repairs` marks `filled`, since those records passed the same checks
- Ask each peer about each gap once (`repairs` table). Retry only transient failures, with backoff and a cap; a finished answer is final, because a peer that missed a stretch can never gain it from the Signed API later

**Be polite to the Signed API**
- One request at a time, spread evenly across the poll interval. Never fetch in parallel or in bursts. Each provider is polled on two hosts (API3's Signed API and its own `signedApiUrl` from the config file); a failing host backs off on its own without slowing the other
- Keep the `POLL_INTERVAL_SECONDS` floor (15 s). Feeds are re-signed every few seconds whether or not the price moved, so polling faster buys rows, not data
- A failed target backs off exponentially (capped at 30 min) and honours `Retry-After`. Never retry in a tight loop
- Every request has a timeout and our `User-Agent`

**Untrusted input**
- Everything from the network is untrusted. Parse it through `toSignedDatum` (exact shape, exact hex lengths) before use, and drop what doesn't match

**Time**
- Signed `timestamp` is unix seconds, set by the signer. `fetched_at` is unix milliseconds, set by us. Never mix the two units in a column or a comparison without converting

**Logging**
- Log through `log` in `src/logger.ts`, never `console`. Lines go to stderr as `14:15:23.917 [info] cycle done saved=2116 rejected=0`: local time, level, message, then logfmt fields. Stdout is for command output only
- The message is a short, fixed, lowercase phrase (`fetch failed`, `cycle done`); everything variable goes in fields, never interpolated into the message. Reuse field names: `provider`, `endpoint`, `status`, `error`, `retryInSeconds`, counts like `saved` and `rejected`
- `debug` is per request, `info` is per cycle or lifecycle, `warn` is something to look at (failed fetch, rejected records), `error` is fatal

**TypeScript style**
- Multi-line arrow functions use braces and an explicit `return`, never a multi-line implicit return. If the body fits on one line (120 cols), collapse it to a one-line implicit return
- Code comments state the rule or the reason, never the history of the change

## Workflow

- Tools are pinned in `mise.toml`; run commands through it (`mise exec -- bun ...`) if the shell doesn't activate mise
- Run `bun run check` (airnode list, Biome, `tsc`, tests with coverage) when done and read its **whole** output
- The CLI is `src/cli.ts` (commander). Every option has a flag and an env var (`.env()`), and a key in the YAML config file (`src/settings.ts`), which supplies commander's defaults: flag beats env beats file beats default. Lists (peers) live only in the file. Validate with one parser shared by the flag and the file, so both accept exactly the same values, and reject unknown config keys
- `bun run build` compiles a native binary to `dist/signed-archive`. The airnode and feed lists are not bundled: they come from the config file at run time, and the Docker image ships `signed-archive.yaml` at `/app/signed-archive.yaml`
- Biome runs strict, with every React rule on. Fix the code, don't disable the rule. The one exception is `noJsxPropsBind`, off on purpose: inline handlers are idiomatic React
- `bun dev` runs the archiver and explorer under `--watch`, so every edit to `src/` restarts the archiver and leaves a gap. Use it for development only; the long-running archive runs `bun start` or the binary
- **Never start, restart or kill a running archiver** (`bun start`, `bun dev`, or the `archiver` container). Ask the user. Stopping it leaves a gap in the history that can never be filled. Test Docker changes under another project name (`docker compose -p sa-test ...`, then `down -v`), never the real one
- The long-lived archive runs in Docker (`compose.yaml`), not under a host service manager. The image is the compiled binary on distroless, as uid 65532, with no shell: health checks and backups are CLI commands (`health`, `backup`), not shell scripts. The Dockerfile's `BUN_VERSION` must match `mise.toml` (`test/versions.test.ts`)
- Don't `sleep` waiting for a background command: it notifies when it exits
- Commit or push only when the user asks
- Never add a `Co-Authored-By` line (or any AI attribution) to commits or PRs
- Commit messages explain the cause and the evidence, not only the change, in plain prose
- Keep `package.json` scripts in alphabetical order

## Testing

- `bun run test` runs with coverage, and `bunfig.toml` sets per-file floors (90% lines and functions) for every source file the tests load. Don't lower a floor to get a change through; add the test
- Tests never hit the network: use real records captured from the API as fixtures (see `test/signed-data.test.ts`)
- A signature test checks both directions: a real record passes, and an edited value, timestamp, template or signer fails
- A regression test should fail on the old code. Check it does before relying on it

## Patterns and gotchas

**Signed API**
- `/public/<airnode>` serves base data delayed ~15 s; `/public-oev/<airnode>` serves fresher data already under the OEV template ID (`keccak256(templateId)`). Both verify with the same scheme
- The API's `/airnodes` route is disabled. The one config file, `signed-archive.yaml`, holds the settings and, below a marker line, the `airnodes` and `feeds` lists generated from `@api3/api-integrations` by `bun run airnodes`. Never edit below the marker by hand; `bun run check` fails if it's stale (e.g. after a Dependabot bump of that package). The lists reach code only through a `Catalog` (`src/catalog.ts`), passed in, never module-level state. Addresses and template IDs stay quoted: YAML may read an unquoted `0x...` as a number
- Responses carry `Cache-Control: max-age=1`; a fresh fetch per cycle is expected

**Bun and SQLite**
- `bun:sqlite` is opened with `strict: true`: SQL uses `$name` placeholders, bound objects use plain `name` keys
- WAL mode is on. Copy the database with SQLite's backup (`VACUUM INTO`), never by copying the file while the archiver runs

**Explorer (`web/`)**
- `serve` (or `archive --serve`) opens the database read-only and serves `web/index.html` through Bun's HTML bundler; there is no separate frontend build. `src/reader.ts` is the only read path
- Records shown in the explorer are checked in the browser: `catalog.isFeedRecord` (signer and template belong to the feed) and `hasValidSignature`. The page builds its catalog from `/api/catalog`, served by the same server as the page's code, so it is trusted exactly as far as the page is. A valid signature alone only proves who signed. Never replace either check with a server-side "valid" flag: the page must not have to trust the server's answers
- The same goes for numbers: wherever the explorer presents a value as checked (the moment panel and the proof), it decodes prices from `encodedValue` and computes the median over verified records with `src/price.ts`, never the server's `price` or `median` strings. `src/price.ts` stays free of Bun and Node imports so it bundles for the browser. The chart and feed list are unverified overviews
- The reader never hides a record: two values signed for the same feed and moment both come back from `at()`. Medians and provider counts take one value per provider
- URL search params come from shared links: parse them through `parseFeedSearch` in `web/search.ts`
- Route components that call `getRouteApi` declare their return type (`JSX.Element`), or the router's registered types collapse to `any` through the import cycle

**Fuzz tests and replay**
- `proofs/` is a Foundry project that reads API3's Solidity unchanged from `node_modules/@api3/contracts`, compiled with the settings `Api3ServerV1` is deployed with (0.8.17, optimizer 1000 runs, london). Never copy or edit those sources; test them as published
- Tests there are `testFuzz_` tests against a plain reference. Halmos was tried and dropped: it proved the average and medians of up to 4 values, timed out beyond that, and added a Python toolchain for little the fuzz tests and replay don't already show
- A fuzz test should fail on a mutated `Median.sol` (e.g. dropping the rounding correction). Check that once when adding one
- `scripts/replay.ts` is a dev script, not part of the binary. A mined transaction that reverted doesn't throw in viem: check the receipt's `status`

**Dependencies**
- Runtime dependencies are `viem` (signature recovery, hashing, hex helpers) and `commander` (CLI), plus React, TanStack Router and TanStack Query for the explorer in `web/`. Reach for Bun's built-ins and the standard library before adding another
- `bunfig.toml` refuses package versions published less than 3 days ago (`minimumReleaseAge`). Don't bypass it to grab a fresh release
- `@api3/contracts` is a dev dependency only (MIT): sources for `proofs/`, and the `Api3ServerV1` ABI and bytecode for the replay script
- `@api3/api-integrations` is a dev dependency only: it is large (the whole Airnode stack) and `UNLICENSED`. Only `scripts/airnodes.ts` imports it; runtime code reads the generated JSON. Its blocked postinstall stays blocked
- `tsconfig.json` sets `skipLibCheck`, because a viem dependency ships types that need browser globals
