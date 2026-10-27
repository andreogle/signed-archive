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

**Be polite to the Signed API**
- One request at a time, spread evenly across the poll interval. Never fetch in parallel or in bursts
- Keep the `POLL_INTERVAL_SECONDS` floor (15 s). Feeds are re-signed every few seconds whether or not the price moved, so polling faster buys rows, not data
- A failed target backs off exponentially (capped at 30 min) and honours `Retry-After`. Never retry in a tight loop
- Every request has a timeout and our `User-Agent`

**Untrusted input**
- Everything from the network is untrusted. Parse it through `toSignedDatum` (exact shape, exact hex lengths) before use, and drop what doesn't match

**Time**
- Signed `timestamp` is unix seconds, set by the signer. `fetched_at` is unix milliseconds, set by us. Never mix the two units in a column or a comparison without converting

**TypeScript style**
- Multi-line arrow functions use braces and an explicit `return`, never a multi-line implicit return. If the body fits on one line (120 cols), collapse it to a one-line implicit return
- Code comments state the rule or the reason, never the history of the change

## Workflow

- Tools are pinned in `mise.toml`; run commands through it (`mise exec -- bun ...`) if the shell doesn't activate mise
- Run `bun run check` (Biome, `tsc`, tests) when done and read its **whole** output
- Biome runs strict. Fix the code, don't disable the rule
- **Never start, restart or kill a running archiver** (`bun start`). Ask the user. Stopping it leaves a gap in the history that can never be filled
- Don't `sleep` waiting for a background command: it notifies when it exits
- Commit or push only when the user asks
- Never add a `Co-Authored-By` line (or any AI attribution) to commits or PRs
- Commit messages explain the cause and the evidence, not only the change, in plain prose
- Keep `package.json` scripts in alphabetical order

## Testing

- `bun test`. Tests never hit the network: use real records captured from the API as fixtures (see `test/signed-data.test.ts`)
- A signature test checks both directions: a real record passes, and an edited value, timestamp, template or signer fails
- A regression test should fail on the old code. Check it does before relying on it

## Patterns and gotchas

**Signed API**
- `/public/<airnode>` serves base data delayed ~15 s; `/public-oev/<airnode>` serves fresher data already under the OEV template ID (`keccak256(templateId)`). Both verify with the same scheme
- The API's `/airnodes` route is disabled, so the airnode list in `src/config.ts` is maintained by hand. Probe a new address once before adding it
- Responses carry `Cache-Control: max-age=1`; a fresh fetch per cycle is expected

**Bun and SQLite**
- `bun:sqlite` is opened with `strict: true`: SQL uses `$name` placeholders, bound objects use plain `name` keys
- WAL mode is on. Copy the database with SQLite's backup (`VACUUM INTO`), never by copying the file while the archiver runs

**Dependencies**
- `viem` is the only runtime dependency (signature recovery, hashing, hex helpers). Reach for Bun's built-ins and the standard library before adding another
- `tsconfig.json` sets `skipLibCheck`, because a viem dependency ships types that need browser globals
