# Ideas and directions

signed-archive keeps a history of API3's signed price data. Every record carries the data provider's signature, so the
archive is evidence anyone can re-check rather than data they have to trust. This document collects where the project
could go next. It is a menu, not a commitment: each idea says who it helps and why it is worth doing.

Three groups can use the archive:

- **The public**: people using DeFi apps, journalists, researchers and anyone who wants to know what a price really was.
- **API3**: the team running the data feeds, AirnodeHub, the OEV auctions and the Morpho vaults it curates.
- **AI agents**: software that looks up prices or data and acts on them, often with money at stake.

## Why this matters now

- **Oracle failures were frequent in 2026**, and most came from wrong prices or wrong settings, not bugs in contract
  code:
  - February: a faulty oracle configuration on Moonwell priced cbETH at about $1.12 instead of about $2,200, leaving
    about $1.8M of bad debt ([CoinDesk](https://www.coindesk.com/tech/2026/02/18/ether-briefly-priced-at-usd1-on-defi-app-moonwell-glitch-triggering-usd1-8m-in-bad-debt)).
  - March: a misconfigured price-cap setting undervalued wstETH on Aave by about 2.85%, triggering about $27M of
    liquidations that should not have happened ([Rekt](https://rekt.news/aave-rekt)).
  - July: an attacker used a stolen Ostium oracle-signer key to post prices dated in the future and drained about
    $23.75M USDC ([The Block](https://www.theblock.co/post/410122/ostium-post-mortem-exploit)).
  - August and September: a signing-key compromise let an attacker manipulate prices on Switchboard's Move-chain feeds,
    and Switchboard deprecated all its deployments on September 19
    ([Crypto Briefing](https://cryptobriefing.com/switchboard-halts-operations-oracle-compromise/),
    [Solana Compass](https://solanacompass.com/news/switchboard-oracle-protocol-shuts-down-giving-solana-defi-six-days-to-migrate)).
  - September: a two-minute pricing fault in Pragma's feed caused Vesu on Starknet to liquidate about $3M across 47
    positions ([Pragma](https://www.pragma.build/updates/vesu-incident)).

  After each incident, people asked "what was the real price?" and had nowhere neutral to look.
- **API3 has no historical price service.** The Signed API only serves the latest value. Pyth offers signed,
  verifiable historical prices through Pyth Benchmarks, a paid API since 2026
  ([Pyth docs](https://docs.pyth.network/price-feeds/core/use-historical-price-data)); API3 does not document an
  equivalent.
- **API3 publishes few public numbers.** Its homepage shows total OEV rewards paid. DefiLlama's oracle ranking showed
  API3 securing about $22M in October 2026, down from a peak of about $470M in early 2024
  ([DefiLlama](https://defillama.com/oracles)). Independent, believable numbers would help API3 win users back.
- **API3 holds every role in its Morpho vaults.** API3 entities are owner, curator, allocator and sentinel, and API3
  says it is also the oracle provider for those markets
  ([API3 docs](https://docs.api3.org/curation/roles-and-operations.html)). An outside record of what those feeds signed
  is the natural check on that.
- **AirnodeHub launched in October 2026** as a marketplace where AI agents find, pay for and verify data. Its docs say
  there is no format yet for bundling several signed answers together, and its catalogue only answers "what is it now?".

## What API3 already has

Checked on 2026-10-28 against the live api3.org subdomains and API3's public GitHub repositories, so this project
builds next to them instead of copying them.

- **API3 Market** (`market.api3.org`, `market-catalog.api3.org`): each feed's current on-chain value, its sources, the
  active plan (for example 2.5% deviation, 24 h heartbeat), and activation and integration. It reads the Signed API
  live. It shows **no price history**.
- **OEV Dashboard** (`oev-dashboard.api3.org`): liquidations per dApp, including API3's Morpho markets, with type (OEV,
  base-feed or plain MEV), OEV bid, revenue, gas and searcher profit, plus charts. This covers the OEV explorer idea
  this document used to list.
- **DAO Tracker** (`tracker.api3.org`): staking, proposals and members. Unrelated to price data.
- **AirnodeHub Community** (`github.com/api3dao/airnodehub-community`): maintained by API3, open to contributions,
  frontend-only by design (no backend or database). It already ships a Trust-Aware Agent, an Asset Price Monitor that
  compares relays with a first-party source, and a Verified Change Tracker that keeps receipts for two snapshots. Its
  own idea list includes a receipt re-verification screen and stale-data and spend-cap recipes.
- **AirnodeHub hackathon starter** (`github.com/api3dao/airnodehub-hackathon-starter`): verifying AirnodeHub (Airnode
  v2) responses on-chain.

Nothing found keeps signed-data history. The Signed API serves only the latest value, the Market shows only the current
one, and the community repo rules out a backend, so persistent, verifiable history is this project's own ground. Where
an idea below touches an existing tool, it says how it complements it.

## Foundation (shared by everything below)

These pieces serve all three groups, so they come first.

1. **Price names.** The archive stores prices under coded template IDs. A lookup generated from API3's own provider
   list turns them into names like "ETH/USD". _Status: built._
2. **Price at any moment, with proof.** Ask "ETH/USD at 2pm Tuesday" and get each provider's signed price at that
   moment, which anyone can re-check. _Status: built (HTTP API)._
3. **Website.** A React explorer with a feeds overview, price history per provider, prices at any moment with
   signatures checked in the browser, and a downloadable proof. Every view is a shareable link. _Status: first version
   built._
4. **Daily files, stamped in Bitcoin for free.** Publish each day's records as downloadable files (for example
   Parquet). Stamp each day's fingerprint into Bitcoin with OpenTimestamps, which is free because public servers batch
   thousands of fingerprints into one transaction. That proves the archive existed on that date and was not edited
   later, without paying on-chain fees. Posting proofs to an Ethereum chain stays optional and can come later if a
   contract needs to read them.
5. **Feed health checks.** Flag the things the archive is built to catch: two different prices signed for the same
   moment, time stamps that go backwards or sit in the future, providers that stop signing, providers that drift from
   their peers, and base and OEV feeds that disagree.
6. **Say how fresh and how complete an answer is.** "Price at a moment" returns each provider's latest record at or
   before that time, however old. When a record is much older than the chosen time, show it plainly, not only in a
   tooltip. Also say what the browser check does and does not prove: a valid signature proves a record is genuine, not
   that the archive holds every record (a server could leave some out). The coverage log and a second archive are what
   answer completeness.

## Reliability and redundancy

The Signed API only serves the latest value, so a moment the archiver misses is gone for good. Today a missed stretch
also looks the same as a provider that stopped signing, because the archive records what it saw, not when it was
watching. In order of value:

1. **Record coverage.** Log every polling cycle (when it ran and which providers answered) in a new table. Gaps then
   become known facts, and the explorer can shade them, instead of looking like silent providers. This is a new table,
   so it does not touch stored records. _Status: built (`polls` table, gaps shaded in the explorer)._
2. **Keep it running, in Docker.** A small image with the compiled binary, `restart: unless-stopped`, the archive on a
   named volume and a container health check. Never run the long-lived archive under `--watch`. Add an outside heartbeat
   (for example healthchecks.io) that alerts when no cycle has finished for a few minutes, since a container that is
   up but stuck looks healthy to Docker. _Status: built (`compose.yaml`, `health` command, `HEARTBEAT_URL`
   ping)._
3. **Run more than one archiver.** Two or more instances on different machines and networks. Each record proves itself
   through its signature, so the copies need no trust in each other.
4. **Read the providers' own Signed APIs too.** Each provider runs its own Signed API (for example
   `signed-api.coingecko.com`, listed as `signedApiUrl` in `@api3/api-integrations`) alongside API3's
   `signed-api.api3.org`. Archiving both gives a second source if one goes down, and shows whether API3's copy ever
   leaves out data the provider published. The same politeness rules apply to every host. _Status: built (each
   poll records its `source`). The first comparison already found conflicting values; see Research._
5. **Merge archives.** A `merge` command reads another archive, re-checks every signature, and adds only records that
   are missing. It never overwrites, so two different values for the same moment both survive as evidence. This fills
   one archive's gaps from another, and is the base of the community archive network below. _Status: built._
   Peers also repair each other automatically: an archive asks each peer in its config file once for any stretch it
   missed, through `/api/records`, and checks every record it gets. _Status: built (`peers`, `repairs` table)._
6. **Recover history from the chain.** Every on-chain feed update carries a signed record in its transaction data
   (`updateBeaconWithSignedData(airnode, templateId, timestamp, data, signature)`). Decoding past `Api3ServerV1`
   transactions recovers verifiable records, including from before this archive started. They are sparse (only when a
   feed was updated on-chain), but they fill gaps with real evidence.
7. **Back up.** A nightly `VACUUM INTO` copy of the volume's database, kept off the machine. Copying the live file is
   not a backup in WAL mode. The daily files from the foundation double as a public backup. _Status: `backup` command
   and compose service built; scheduling and moving copies off the machine are up to the host._

Polling samples each feed about once a minute. Records signed between polls are not captured by design: providers
re-sign every few seconds whether or not the price moved, so polling faster buys rows, not data.

## For the public

- **Time machine.** Pick any date and see every price, which providers agreed, and a "check it yourself" button. Every
  view gets a shareable link.
- **"Was I liquidated fairly?"** Paste a wallet address and see the price that triggered a liquidation next to what
  every provider actually signed at that moment. It is personal, easy to share and keeps working after the news cycle.
  The OEV Dashboard already lists the liquidations; what it lacks is the signed prices around each one, so link to it
  rather than rebuild the list.
- **Incident reports.** When a price feed breaks anywhere, publish a neutral timeline within hours: what the sources
  signed, what reached the chain and when. Think of an air-crash investigation board, for prices.
- **Shareable proof cards.** "On 12 October at 14:03, ETH was $X, signed by five providers", as a link or image that
  journalists and posters can embed and readers can verify.
- **Open data.** The daily files make the history available to researchers and students without anyone running their
  own archiver.
- **How stale is DeFi right now?** A live map of the gap between each chain's on-chain API3 value and the newest
  signed value, across the roughly 40 chains API3 serves. It shows at a glance which chains and feeds lag, and
  nothing shows this today. Needs an RPC endpoint per chain.
- **A public board for conflicting signatures.** The archive watches for a provider signing two values for one
  moment, and the board publishes any such pair with the fraud-proof contract (see Research), so anyone can prove it
  on-chain. It works mostly as a deterrent: likely empty, and still meaningful when it is.

## For developers and other businesses

Products that only past signed prices make possible. API3 itself only exposes the latest value on-chain.

- **Replay real oracle history on a test chain.** The archived signatures are genuine, so a local fork (for example
  with anvil) accepts them in `Api3ServerV1` as if they were live. Fork just before an event (a crash, a depeg, a
  glitch), then push the archived records in time order while stepping the fork's clock. Any protocol that uses API3
  can test its liquidations, caps and circuit breakers against what really happened, signed and byte for byte. Agents
  can be tested the same way. The contract only accepts a time stamp newer than the stored one and less than an hour
  ahead, so the fork must start before the replayed stretch; base feeds work this way, OEV updates are harder. It is a
  CLI command, with nothing to deploy. _Status: prototype built (`bun run replay`) on a fresh local chain with the
  real `Api3ServerV1`: every archived record tried so far was accepted on-chain, and every beacon set median matched
  `src/price.ts`. Replaying into a fork of a real chain is next and needs an archive node._
- **Settle a contract at any past moment.** A Solidity library plus the archive's API: a contract checks a signed
  record against the provider's address and the feed's template ID (about 3k gas per signature). Options expiry,
  bets, escrow and insurance triggers can then settle on "the price at noon Friday" even if nobody pushed an update
  on-chain then. A contract cannot prove a record was the latest one at or before the moment, so the submitter could
  pick a favourable one. Accept any record in a window up to the moment, then hold a challenge period in which anyone
  can replace it with a later record that is still at or before the moment.
- **Price certificates for audits and accounting.** Auditors need an independent fair value at the time of a
  transaction, and today they take an exchange's API or a screenshot on trust. A certificate for a transaction hash or
  a time (a PDF plus the signed records) gives several independent providers' signed prices, checkable years later.
  Whether auditors accept it is unproven: ask a firm before building.
- **Evidence packets for insurance claims and disputes.** DeFi insurers and dispute courts (Nexus Mutual, Kleros, UMA)
  have to decide what a price was at a moment. One verifiable bundle holds every provider's signed price, the median,
  the archive's coverage around the moment and when the update landed on-chain.
- **A TWAP that carries its own proof.** A time-weighted average or volatility figure served together with every
  evenly spaced signed sample behind it, so a client or a contract can recompute it and check every signature. That
  gives a verifiable figure without zero-knowledge proofs. On-chain history cannot do this, because it only records
  updates on large moves.

## For API3

- **Provider report cards.** Score each provider on staying online, freshness, agreement with peers and never
  contradicting itself. API3 can use the scores to choose providers for each feed, and they show the public that the
  feeds are watched.
- **Second opinion for the Morpho vaults.** An outside view of feed health and borrower risk for the vaults API3
  curates, aimed at depositors. It builds the trust that holding every role makes hard to earn alone.
- **"What if" simulator for risk settings.** Replay real history under different settings: if this feed updated on a
  0.5% move instead of 1%, how many liquidations would change? Useful for the curation team when setting caps and
  loan-to-value limits. The same replay can measure what the deliberate ~15 second delay on base data costs lenders
  during sharp moves.
- **On-chain match-up.** Compare every on-chain feed update with the signed record it came from. Measure how quickly
  updates land and whether each one was triggered by a price move or by the regular heartbeat.
- **OEV freshness.** The OEV Dashboard already covers auctions and liquidations. The archive can add one thing it
  does not show: how much fresher OEV data is than base data, measured from both feeds' signed time stamps.
- **Early-warning bot.** A bot on X or Telegram that posts "provider X stopped signing BTC/USD 12 minutes ago", plus a
  weekly feed-health summary. It could also flag feeds at risk of being shut down for low liquidity, as API3
  reportedly did with Blast USDB/USD in 2025 (only aggregators report this; confirm with API3 before relying on it).
- **Archive network.** If several people run signed-archive, they can merge their records. Each record proves itself
  through its signature, so nobody has to trust anybody, and one archive's gap is filled by another. Today a stopped
  archiver loses that stretch of history for good.

## For AI agents

AI agents can make up numbers and often cannot show where a fact came from. Signed history answers both.

- **Agent plug-in (MCP server).** One plug-in with four abilities:
  - **Past price with proof**: "what was ETH at 2pm last Tuesday?", answered with the providers' signatures.
  - **"Is this price safe to use?"**: is it fresh, do the sources agree, is the time stamp not in the future? For
    live AirnodeHub answers, the community Trust-Aware Agent and Asset Price Monitor already do this; the plug-in only
    adds it for API3 data feeds and their history.
  - **Source report cards**: which providers have been reliable.
  - **Independent signature check**: so agents do not rely on AirnodeHub checking its own answers.
- **Receipt drawer.** File every signed answer an agent receives, so the agent or its owner can later show exactly
  what it knew when it acted. This matters most for agents that handle money. The community repo keeps receipts in the
  browser only; a durable store is the part it leaves open. Match its receipt format so the two work together.
- **Gatekeeper before payment.** AirnodeHub agents pay per call. Before money leaves, check whether the listing is the
  original source or a relay, whether the signer is the same as last month, whether the price is within budget, and
  how reliable the source has been. A spend cap and source ranking are already on the community idea list, so
  contribute those there; the archive adds the track record behind "how reliable".
- **"Show your work" bundles.** Package several signed answers and the agent's conclusion into one file anyone can
  check. AirnodeHub's docs say this format does not exist yet; a proposal with a reference checker could be offered
  upstream.
- **Signer history.** Record which signing address each AirnodeHub listing used over time. Without it, an old signature
  cannot be tied to a provider once a key changes.
- **Crash simulator.** Replay real price crashes and broken feeds from the archive to test how an agent reacts. Does it
  panic, or does it notice the bad data?
- **Wake-me-up alerts.** "Tell me when ETH moves 3% across the signed sources", so agents stop asking every few
  seconds.
- **Referee for agreements.** Two parties agree "if BTC is above $X at noon Friday, you pay me". The archive's signed
  noon price settles it, and a contract can check the signatures itself.
- **Historical prices on AirnodeHub.** List "signed price at any past moment" as an AirnodeHub service. It would be the
  first community-run listing. _Needs API3:_ API3 builds and hosts every listing today, and providers running their
  own nodes is still a plan, so this starts as a proposal to them, not something this project can ship alone.

## Proofs

No oracle we could find publishes formal specifications of its contracts, and API3's public repositories have unit
tests only (no fuzzing, invariant tests or formal verification). Machine-checked proofs of API3's own rules are
unclaimed ground. Cheapest first:

1. **Symbolic tests of `Median.sol` with Halmos.** Run against the real Solidity: the overflow-safe average equals
   `(x + y) / 2` rounded toward zero, the sorting and quickselect paths give the same median, and the median lies
   between the smallest and largest input. `src/price.ts` already follows the same rounding rule. _Status: tried here and
   removed. Halmos proved the average for every input and the median of up to 4 values, then timed out; Foundry fuzz
   tests covered lengths 1 to 21. For the archive, the replay against the deployed bytecode already shows its median
   matches the contract, so these belong in a separate repo if proofs of API3's code become a goal of their own._
2. **Majority rules for combined feeds (Lean 4).** Prove that if fewer than half of the providers behind a combined
   feed lie, the median stays between the lowest and highest honest prices. This is the security claim of API3's
   combined feeds, stated as a theorem. Lean's `BitVec 256` matches the EVM's integers exactly.
3. **A rule the contract only implies.** `updateBeaconSetWithBeacons` never checks that a combined feed's time stamp
   goes up. It follows from each provider's time stamp only going up and from the median keeping order, and that
   chain is worth proving. Related: a combined feed's value can change while its time stamp stays the same, which
   breaks any consumer that caches by time stamp.
4. **A model of base versus OEV updates (Quint).** A few hundred lines covering signing, the delayed base push, auction
   awards and OEV updates. Check that what a dApp reads never goes back in time, is never older than the base feed,
   and never uses data from after the auction's cutoff. Timing bugs like these are invisible to contract-level tools.
5. **Messages cannot be confused.** Prove that the way a signed message is assembled (template, time, value) can never
   produce the same bytes for two different messages. The harder and more valuable target is the canonical JSON behind
   AirnodeHub's request hash, and any bundle format proposed above.
6. **A reference checker run against the archive.** Write the signature check in Lean, run it over every stored
   record and require it to agree with the TypeScript check. That ties the proofs to real data. Test vectors
   generated from the Lean model can also be checked against `Median.sol` in Foundry.
7. **Verify the contracts end to end.** Tools such as Verity, EVMYulLean and EquiVM can prove properties of the
   deployed code. This is weeks of work and comes after the items above.
8. **Safety margins for lending markets.** Bound how far the on-chain price can lag the signed price, given how often
   feeds update, and turn that into a safety condition for loan limits. Check it against archive data.

Bend was considered and set aside for now: it has no signed 256-bit integers, no proof library and no link to
Solidity. Lean 4 covers the same ground with a mature toolchain.

## Research and security tools

Public goods for the wider oracle ecosystem that the archive makes possible.

- **How much can an updater cherry-pick?** An OEV auction winner updating a combined feed may skip any provider or
  choose any signed value up to the auction's cutoff before the median is taken. Prove a bound on how far that choice
  can move the result, then measure it on archived data. The same question applies to other pull oracles (Pyth,
  RedStone). This is the idea most likely to become a paper.
- **Fraud proof for conflicting signatures.** Two valid signatures from one provider for the same feed and time stamp
  with different values are a self-contained proof of misbehaviour. A small contract can check such a pair for about
  6k gas. The archive is where such pairs would be found, and the reader already keeps both.
- **Conflicting values are real, between a provider's two copies.** On 2026-10-28, within 12 seconds of the archiver
  starting to read providers' own Signed APIs as well as API3's, it found the same key signing different values for
  the same feed and second: 660 moments in 35 minutes (ncfx 521, blocksize 92, coinmetrics 38, nodary 9), none in the
  23 hours of API3-only data before. Example: blocksize signed ETH/USD at both 2351.3505 and 2351.6995 for one second.
  The likely cause is a separate signing pipeline per Signed API, each fetching its own upstream price, which is not
  misbehaviour in itself. It does mean two genuine signed prices exist for one moment, so whoever pushes an update
  on-chain (Airseeker, or an OEV auction winner) can pick between them. Measure how far apart such pairs are, ask the
  providers and API3 whether it is intended, and feed it into the cherry-picking bound.
- **A static check for oracle consumers.** Slither has detectors for unchecked Pyth and Chronicle prices but none for
  API3. An `api3-unchecked-timestamp` detector (a contract that ignores the time stamp `read()` returns) matters
  because nothing on-chain rejects stale API3 data. Merged upstream, it reaches every Slither user.
- **Drop-in specs for oracle consumers.** Reusable Halmos and Certora rules that any protocol can run: freshness bound,
  positive value, decimals, L2 sequencer grace period, and no action on a value that changed under an unchanged time
  stamp.
- **Oracle comparison.** With Chainlink and Pyth updates recorded beside API3's, publish who was fastest and closest
  during sharp moves. Independent numbers here are rare; vendor comparisons are not neutral.

## Deliberately not doing

- **A trading bot.** The public data is about 15 seconds behind by design, the fast version is auctioned to approved
  partners, and conditional orders already exist elsewhere. The archive's value is as a referee, not a trader.
- **Paying for on-chain storage of every day.** Free Bitcoin timestamps give the same tamper evidence.
- **Zero-knowledge proofs of derived prices.** Checking a few signatures directly costs about 3k gas each, far less
  than verifying a proof (about 270k gas), and demand for proven averages or volatility is thin.
- **Tools for OEV searchers.** OEV updates are limited to API3's partnered searchers since the public OEV Network was
  retired in November 2025, so there is no open market to serve.
- **Staking-backed guarantees for providers.** API3 designed this in 2021-22 and never shipped it, and other oracles'
  penalties are token-sized. Published reliability scores give most of the value.

## Suggested order

1. Price names and price at any moment with proof. _Done._
2. Website with the price explorer and in-browser checks. _First version done._
3. Reliability, now: coverage log and `merge` _(done)_, then Docker with a heartbeat alert and nightly backups, then a
   second archiver and the providers' own Signed APIs. History only accrues from the day it is recorded, so this comes
   before new features.
4. Daily files with Bitcoin timestamps. They double as the public backup and the open dataset.
5. Replay tool _(prototype done)_ and settle-at-a-moment library. Both reuse the signature and feed checks the explorer already runs,
   and one real event from the archive is enough to show them.
6. Freshness labels, feed health checks and provider report cards.
7. Agent plug-in (MCP server).
8. The cherry-picking bound and the fraud-proof contract, once the archive holds enough history to measure.
9. Liquidation checker, incident reports, price certificates and evidence packets.
