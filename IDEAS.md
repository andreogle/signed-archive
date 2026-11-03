# Ideas for signed-archive

Keep the signed evidence, make it easy to check, and help people explain what happened.
These are possible directions, not a backlog we have promised to build.

## Already here

The archive polls API3 and providers' own Signed APIs, verifies signatures, and keeps conflicting values.
It has an explorer with browser verification, downloadable proofs, HTTP and MCP APIs, coverage tracking,
peer repair, archive merging, and Docker health checks and backups. See [README.md](README.md) for how they work.

## Worth doing next

### Make incomplete answers obvious

Show freshness, missing providers, conflicting values, and archive gaps beside each price. Make it clear when
an answer uses a record from much earlier than the requested time. A signature proves who signed a value;
it does not prove that the archive has every record or that the value was correct.

Start with a clearer moment panel. Extend the same explanation to downloaded proofs and MCP answers.

### Publish evidence people can keep

Offer daily exports and small incident bundles containing the raw signed records, the feed catalog used to
interpret them, and the relevant coverage information. Include a checker that works without this server.
Publish file hashes so people can compare copies; an independent timestamp could later establish that a
particular bundle existed by a certain time.

Start with one downloadable day and one command to verify it. Coverage and catalog metadata need their own
provenance: provider signatures only authenticate the signed fields.

### Learn from independent archives

Run another archive on a different network and measure what each one misses. Show which records peer repair
recovered and which gaps remain. This gives us evidence about how much redundancy helps, before building
anything more elaborate.

Start with two instances and a weekly comparison of verified records. Agreement between them still does
not prove that neither missed anything.

## Ideas to explore

### How much choice does an updater have?

For a chosen moment, show how the result changes when using different observed provider subsets or either
side of a conflicting signature pair. Attach the records and spell out the selection and freshness rules.
This makes the consequences of cherry-picking visible instead of hiding them behind one median.

Start with one feed and one real conflict. Any claim about what a contract would accept needs that contract's
actual rules; missing records mean the archive can only show the choices it observed.

### Replay an incident without hindsight

Feed a recorded event into a developer's application or an agent, revealing records in the order an archive
observed them. Include delays, outages, and conflicting values. Can the application spot stale data before
acting? Would a different freshness limit have changed its decision?

Start with a local replay of one incident. Observation times are the archive's unsigned claims, and a signed
timestamp is not proof that the record was publicly available then. Keep those two clocks visible.

### Find the smallest example that explains a failure

Turn a confusing incident into a tiny reproducible case: the two conflicting records, the missing provider,
or the sequence that made a price stale. Export the records, the rule being tested, and the expected result.
A protocol team could drop that example into its tests instead of downloading a whole archive.

Start with conflicting signatures, where two real records already make a useful test case.

### Let archives challenge each other's answers

Given an answer bundle, ask independent archives whether they have a newer eligible record, a missing provider,
or another value signed for the same moment. Return any counterexample with its signature, so a reader can
check why the original answer was incomplete.

Start with a manual “compare with another archive” action. Finding a counterexample establishes an omission;
finding none does not establish completeness or deliberate misconduct.

### Keep receipts for decisions

Let an application or agent save the exact records it used, its freshness and disagreement limits, and the
result of those checks. Later, someone can reproduce the calculation and see whether it followed its stated
rules, even if the archive has since gained more history.

Start with a downloadable receipt for one MCP price check. A receipt explains a decision; it does not prove
that the application actually acted on it or that the decision was financially sound.

### Connect a signed price to what happened on-chain

For one transaction, put the on-chain value beside the archived signed values and their observation times.
Explain the difference between what providers signed, what the archive saw, and what the application used.
This could support incident reports, liquidation investigations, and tests of different risk settings.

Start with one supported contract and a worked example. Recover historical signed records from transaction
inputs where available, verify them normally, and retain their origin. A price comparison alone cannot decide
whether a liquidation was fair.

## How to choose

Prefer work that uses the evidence we already keep, answers a concrete question, and can be demonstrated with
one feed or incident. Build the smallest useful example before adding a service or integration.

Keep formal verification of third-party contracts, trading bots, new tokens, and general-purpose dashboards
outside this project's scope. The archive's strength is durable evidence that someone else can check.
