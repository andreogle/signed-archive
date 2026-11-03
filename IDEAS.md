# What people could build with signed-archive

signed-archive keeps API3's signed data after the live API has moved on. That history can become the evidence
behind other people's products: an incident investigation, a protocol test, a provider comparison, or an
agent's explanation of a decision.

These are ideas for projects built **on top of the archive**, by API3, outside developers, or AI agents.
They are not a roadmap to turn signed-archive into those products. The archive supplies records and ways to
check them; builders supply the application, extra data, and rules for interpreting the result.

## What builders can use today

- Historical signed records through the HTTP API and MCP tools.
- A price explorer with browser verification, shareable views, and downloadable proofs.
- Conflicting values preserved together, with summaries of when providers contradicted themselves.
- Polling history and peer repair to help explain gaps in what the archive observed.

See [README.md](README.md) for the interfaces and how to run an archive. Moved days are published as Parquet
files under `/data/`; a portable bundle checker and timestamping those files (for example with OpenTimestamps) could
make larger downstream projects easier, and are not available yet.

## For API3

Use independent history to understand feed behaviour, help integrators choose settings, and explain incidents.

- **Provider report cards.** Publish freshness, availability, disagreement, and conflicting-signature rates
  per provider and feed. Link every finding to the underlying records and show archive gaps separately from
  provider failures. This gives provider selection and operational reviews something concrete to work from.

- **Risk-setting simulator.** Replay an event under different update thresholds, maximum ages, price caps,
  and lending settings. Show which decisions would have changed. Start with one market; meaningful liquidation
  simulations also need its contract rules, positions, and on-chain state.

- **A second opinion for vault depositors.** Build an independent feed-health and historical risk report for
  a vault, including API3-related Morpho markets where applicable. Connect oracle observations to the market's
  actual configuration, so depositors can inspect the evidence behind its risk choices.

- **Signed-to-chain comparison.** Compare observed signed records with the values applications actually read
  on-chain. Show update delays, stale periods, and differences between chains. This needs RPC or indexed chain
  data alongside the archive, and could help distinguish signing, delivery, and update problems.

- **Base versus OEV analysis.** Measure differences in signed timestamps and values during ordinary periods
  and sharp moves. Add this evidence to auction or liquidation investigations, without assuming that a newer
  signed timestamp proves a record reached every participant earlier.

- **Operational alerts and incident reports.** Notify operators when observed signing stalls, timestamps move
  backwards, or values diverge, then assemble a timeline with the signed evidence. The same project could
  produce weekly health summaries for integrators.

- **Provider diversity analysis.** Look for providers that fail together, lag together, or repeatedly produce
  matching changes. Help teams test whether adding a provider improves resilience. Correlated behaviour is a
  reason to investigate shared dependencies, not proof of a shared upstream source.

- **Before-and-after change reports.** Compare feed behaviour around a provider rollout, signing-key change,
  or configuration update. Highlight changes in latency, disagreement, and conflicts. Deployment dates and
  authenticated configuration history would come from API3 or the provider.

## For outside developers and businesses

Build tools that turn signed history into reproducible tests, useful calculations, and evidence for customers.

- **Replay real incidents in a test environment.** Feed archived records into a local chain fork or application
  harness to test liquidations, circuit breakers, and stale-price handling. Reproduce one event before making
  a general tool; a contract replay needs the right starting state and its actual acceptance rules.

- **Small regression cases from real failures.** Package the smallest sequence that demonstrates a problem:
  two conflicting signatures, a stale record, or disagreement before a depeg. Include expected behaviour so
  protocol teams can add the case to their test suite.

- **Historical settlement.** Explore a library or service for options expiry, escrow, insurance triggers, or
  agreements tied to a past price. Define provider selection, freshness windows, aggregation, and a dispute
  process. A valid signature alone cannot establish that a submitted record was the latest eligible one.

- **Price certificates for accounting and audits.** Produce a readable report for a transaction or valuation
  time, with the signed records and calculation attached. Start with an auditor's actual requirements rather
  than assuming that cryptographic evidence automatically satisfies an accounting standard.

- **Evidence packets for claims and disputes.** Assemble provider records, conflicts, coverage, and relevant
  on-chain events into one independently checkable case file. Insurers, researchers, and dispute reviewers
  could use the same evidence without relying on screenshots.

- **Reproducible price statistics.** Offer time-weighted averages, volatility, or depeg measurements together
  with the signed samples and calculation method. State the sampling and gap policy so another person can
  reproduce the result and see how missing observations affect it.

- **Liquidation investigations.** Given a transaction, explain the price used, the market's rules, and what
  providers signed around that moment. Show where those disagree. This supports an investigation; a price
  comparison by itself does not establish whether a liquidation was fair.

- **Feed-selection workbench.** Let an integrator compare candidate provider sets against the same historical
  events. Show how dropping a provider, changing a freshness limit, or choosing one side of a conflict changes
  the result. This could expose fragile assumptions before an integration goes live.

- **Historical signer and feed directory.** Preserve dated catalog snapshots and authenticated announcements
  tying providers, keys, and templates to feed names. A verifier could then explain an old record after a key
  rotation or catalog change. The archive's current catalog alone is not that historical authority.

- **Cross-oracle research.** Combine this archive with separately collected data from other oracle systems to
  study observed delay, disagreement, and behaviour during stress. Keep each system's verification scheme and
  observation method explicit, so the comparison is meaningful.

## For AI agents and the people building them

Use the existing MCP server as an input to agents that can show where their numbers came from.

- **Research with checkable citations.** Answer historical price questions with the records, their ages,
  provider identities, and a reproducible calculation. An owner can verify the numerical evidence separately
  from the agent's narrative. Basic historical-price and price-check tools already exist in MCP.

- **A receipt for every decision.** Save the exact records an agent used, its freshness and disagreement limits,
  and the checks it ran. Later, reproduce its reasoning even if another archive has since recovered more
  history. The receipt records stated inputs and rules; proving execution needs the application's own logs.

- **“Show your work” bundles.** Attach a portable evidence bundle to a multi-step answer, such as a depeg timeline
  or a price comparison. Include intermediate calculations and a small checker, so the recipient does not need
  to trust the agent's arithmetic or keep access to its session.

- **A second agent that challenges the answer.** Before relying on a result, ask another archive for a newer
  eligible record, an omitted provider, or a conflicting value. Return any counterexample with its signature.
  Finding one explains an omission; finding none does not prove the answer complete.

- **Agent evaluations without hindsight.** Replay incidents in observation order and score whether an agent
  spots stale data, asks for missing evidence, or declines to answer when evidence is weak. Preserve the
  difference between a provider's signed time and the archive's unsigned observation time.

- **Try a policy before enabling actions.** Run an agent's proposed rules over recorded events without giving
  it authority to act. Report what it would have done, which inputs drove the decision, and how often small
  changes to its limits reverse the result. This is a separate evaluation tool, not a trading feature here.

- **Alerts with evidence attached.** Let an agent subscribe to questions such as “did several providers observe
  a 3% move?” or “has this feed stopped producing fresh records?” Send the supporting records with the alert
  instead of repeatedly asking an agent to poll and interpret an entire feed list.

- **Source checks before buying data.** Use provider history, signer continuity, and freshness requirements as
  inputs to a purchasing agent's decision. An AirnodeHub or other marketplace integration would also need its
  own listing identities, payment limits, and verification rules; price-feed history is only one input.

- **Historical data as an agent service.** Build a service around past-price queries, incident bundles, or
  provider comparisons, potentially exposed through AirnodeHub or another marketplace. Confirm integration
  requirements with that platform. Other signed-answer formats need separate verification adapters.

- **A referee for agent agreements.** Give two agents the same checkable evidence for a condition such as
  “what was BTC/USD at noon?” Agree on sources, time windows, aggregation, and missing-data handling first.
  For automated settlement, the dispute and selection problems are the same as for developer-built contracts.

## For the public and researchers

- **Incident timelines and proof cards.** Publish clear explanations with links to signed evidence that readers
  can download and check. Build on the explorer rather than presenting an unsupported screenshot as proof.
- **A map of stale on-chain prices.** Combine archive observations with chain data to show where applications
  are using older values, with the observation window and uncertainty visible.
- **Open research datasets.** Publish selected events and reproducible notebooks for studying conflicts, depegs,
  and provider behaviour. Keep raw records with derived results so later researchers can check the work.
- **A community of independent observers.** Run archives on different networks and compare what they captured.
  Measure how much peer repair recovers and publish counterexamples when an answer omits available evidence.

## Useful first demonstrations

1. **API3:** a report card for one feed over one week, with links to every flagged event.
2. **Developers:** a real incident replay and a small regression case a protocol can use in its tests.
3. **AI agents:** a historical answer with a decision receipt, checked independently by another client.

Each can be a separate project using the existing archive. Start with a concrete user and a small example;
let demonstrated needs guide any additions to the archive's interfaces.

## What the evidence does and does not say

Provider signatures authenticate the signed fields. They do not prove market truth, complete history,
public availability at the signed time, or the correctness of a downstream decision. Polls, observation
times, catalog mappings, and coverage claims have their own provenance. Keep those distinctions visible
in every product built on top, and distinguish existing capabilities from proposed integrations.
