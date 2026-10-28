# Ideas and directions

signed-archive keeps a history of API3's signed price data. Every record carries the data provider's signature, so the
archive is evidence anyone can re-check rather than data they have to trust. This document collects where the project
could go next. It is a menu, not a commitment: each idea says who it helps and why it is worth doing.

Three groups can use the archive:

- **The public**: people using DeFi apps, journalists, researchers and anyone who wants to know what a price really was.
- **API3**: the team running the data feeds, AirnodeHub, the OEV auctions and the Morpho vaults it curates.
- **AI agents**: software that looks up prices or data and acts on them, often with money at stake.

## Why this matters now

- **Oracle failures were frequent in 2026.** Aave (about $27M of wrong liquidations in March), Moonwell (cbETH priced at
  $1 in February), Vesu on Starknet ($3M liquidated in September) and Switchboard (halted after manipulation in August)
  all lost money to wrong prices or wrong settings, not to bugs in contract code. Ostium lost up to about $24M when an
  attacker stole a signing key and posted prices dated in the future. After each incident, people asked "what was the
  real price?" and had nowhere neutral to look.
- **API3 has no historical price service.** The Signed API only serves the latest value. Pyth sells signed historical
  prices (Pyth Benchmarks); API3 has nothing equivalent.
- **API3 publishes few public numbers.** Its homepage shows total OEV rewards paid. DefiLlama estimates the value API3
  secures in the low tens of millions, down from about $470M in 2024. Independent, believable numbers would help API3
  win users back.
- **API3 holds every role in its Morpho vaults.** It is owner, curator, allocator and sentinel, and its own feeds price
  the markets. An outside record of what those feeds signed is the natural check on that.
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

## Reliability and redundancy

The Signed API only serves the latest value, so a moment the archiver misses is gone for good. Today a missed stretch
also looks the same as a provider that stopped signing, because the archive records what it saw, not when it was
watching. In order of value:

1. **Record coverage.** Log every polling cycle (when it ran and which providers answered) in a new table. Gaps then
   become known facts, and the explorer can shade them, instead of looking like silent providers. This is a new table,
   so it does not touch stored records. _Status: built (`polls` table, gaps shaded in the explorer)._
2. **Keep it running.** Run the compiled binary under a supervisor (launchd on macOS, systemd on Linux) that restarts
   it if it crashes, never under `--watch`. Add an outside heartbeat (for example healthchecks.io) that alerts when no
   cycle has finished for a few minutes.
3. **Run more than one archiver.** Two or more instances on different machines and networks. Each record proves itself
   through its signature, so the copies need no trust in each other.
4. **Merge archives.** A `merge` command reads another archive, re-checks every signature, and adds only records that
   are missing. It never overwrites, so two different values for the same moment both survive as evidence. This fills
   one archive's gaps from another, and is the base of the community archive network below. _Status: built._
5. **Recover history from the chain.** Every on-chain feed update carries a signed record in its transaction data
   (`updateBeaconWithSignedData(airnode, templateId, timestamp, data, signature)`). Decoding past `Api3ServerV1`
   transactions recovers verifiable records, including from before this archive started. They are sparse (only when a
   feed was updated on-chain), but they fill gaps with real evidence.
6. **Back up.** A nightly `VACUUM INTO` copy kept off the machine. The daily files from the foundation double as a
   public backup.

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

## For API3

- **Provider report cards.** Score each provider on staying online, freshness, agreement with peers and never
  contradicting itself. API3 can use the scores to choose providers for each feed, and they show the public that the
  feeds are watched.
- **Second opinion for the Morpho vaults.** An outside view of feed health and borrower risk for the vaults API3
  curates, aimed at depositors. It builds the trust that holding every role makes hard to earn alone.
- **"What if" simulator for risk settings.** Replay real history under different settings: if this feed updated on a
  0.5% move instead of 1%, how many liquidations would change? Useful for the curation team when setting caps and
  loan-to-value limits.
- **On-chain match-up.** Compare every on-chain feed update with the signed record it came from. Measure how quickly
  updates land and whether each one was triggered by a price move or by the regular heartbeat.
- **OEV freshness.** The OEV Dashboard already covers auctions and liquidations. The archive can add one thing it
  does not show: how much fresher OEV data is than base data, measured from both feeds' signed time stamps.
- **Early-warning bot.** A bot on X or Telegram that posts "provider X stopped signing BTC/USD 12 minutes ago", plus a
  weekly feed-health summary. It could also flag feeds at risk of being shut down, as happened to USDB/USD when its
  market dried up.
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
  first community-run listing.

## Formal verification

Lean, a tool for writing machine-checked mathematical proofs, cannot check this TypeScript directly, but it can prove
the rules the project relies on.

1. **Majority rules for combined feeds.** Prove that if fewer than half of the providers behind a combined feed lie,
   the combined price (the median) stays between the lowest and highest honest prices. This is the security claim of
   API3's combined feeds, stated as a theorem. Check the exact rule in `Api3ServerV1` before writing it.
2. **Messages cannot be confused.** Prove that the way a signed message is assembled (template, time, value) can never
   produce the same bytes for two different messages. The harder and more valuable target is the canonical JSON behind
   AirnodeHub's request hash, and any bundle format proposed above.
3. **A reference checker run against the archive.** Write the signature check in Lean, run it over every stored
   record and require it to agree with the TypeScript check. That ties the proofs to real data.
4. **Verify the contracts.** Tools such as Verity, EVMYulLean and EquiVM can prove properties of the on-chain code.
   This is weeks of work and comes after the first three.
5. **Safety margins for lending markets.** Bound how far the on-chain price can lag the signed price, given how often
   feeds update, and turn that into a safety condition for loan limits. Check it against archive data.

## Deliberately not doing

- **A trading bot.** The public data is about 15 seconds behind by design, the fast version is auctioned to approved
  partners, and conditional orders already exist elsewhere. The archive's value is as a referee, not a trader.
- **Paying for on-chain storage of every day.** Free Bitcoin timestamps give the same tamper evidence.

## Suggested order

1. Price names and price at any moment with proof. _Done._
2. Website with the price explorer and in-browser checks. _First version done._
3. Reliability: coverage log and `merge` _(done)_, then a supervisor, a heartbeat alert and a second archiver.
   History only accrues from the day it is recorded, so this comes before new features.
4. Agent plug-in (MCP server).
5. Daily files with Bitcoin timestamps.
6. Feed health checks and provider report cards.
7. Liquidation checker and incident reports, once the archive has enough history.
