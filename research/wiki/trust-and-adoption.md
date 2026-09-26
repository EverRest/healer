# Trust and adoption

Autonomy is not a feature flag. It is a relationship that starts at zero and is extended in
increments that the customer controls, per component and per action.

## The ladder is also the sales path

```text
L0  detect                  no trust required
L1  diagnose                reads production; still no write anywhere
L2  fix + pull request      writes to a branch; humans merge     ← year-one ceiling
L3  merge                   requires measured false-fix rate
L4  deploy + verify         requires rollback proven in their environment
L5  autonomous remediation  per component, never globally
```

Each rung is a separate conversation with a separate security review. Nobody buys L3 on day one,
and offering it early signals that we do not understand the risk they are carrying.

## The asymmetry that governs everything

A hundred correct diagnoses do not offset one bad merge. Trust in this category is destroyed by
single events, not by averages. Practical consequences:

- **Reversible actions are governed separately from irreversible ones.** Rollback can be
  autonomous long before a patch can, because being wrong costs a deploy rather than a codebase.
- **The honest headline metric is diagnosis usefulness, not auto-resolution rate.** Optimising
  auto-resolution creates pressure to merge marginal fixes — exactly the pressure that produces
  the single bad event.
- **`INCONCLUSIVE` must be a respectable outcome.** A system that never says "I could not
  reproduce this" is a system that guesses.

## What earns the next rung

Not time, and not the vendor's confidence. Evidence the customer can inspect:

| To enable | They need to see |
|---|---|
| L1 | Diagnoses that match what their engineers concluded independently |
| L2 | Pull requests merged with few or no edits, over months |
| L3 | A measured false-fix rate on their own incidents, plus per-class limits |
| L4 | Rollback demonstrated in their environment, under load |

## The rung is gated by a build, not by a conversation

"Requires measured false-fix rate" was, until the stage-0 review, a sentence. The permission ceiling is a
pure function in code with no level for `merge`, and raising it is an ordinary pull request — which every
gate in the repository passed, because the gates check grant rows *against* the ceiling and nothing looked
at the ceiling itself.

Now a diff that raises a level fails the build unless it cites a derivation the build can resolve: a
complete, repeatable run over incidents that are real, adjudicated, at least twenty in the denominator, and
**not the ones the prompts were tuned on** (C-29, C-30).

This is worth saying out loud in a sales conversation, because it inverts the usual claim. Every vendor
says autonomy is earned. The question a good customer asks is *what happens when your team wants to ship
the next level anyway* — and the honest answer is normally "our judgement". Here the answer is that the
build refuses, and the measurement cannot have been taken on data we fitted to.

## The simulator is the trust instrument

Replaying historical incidents — *"here is what we would have done to your last twenty, and where
policy would have stopped us"* — is the only way to demonstrate behaviour without being granted
access first. It is a demo, an evaluation harness and a safety tool in one artifact, which is why
it belongs early rather than at the end.

## Onboarding friction is a trust cost too

Every integration step before first value is an opportunity to abandon. Connecting observability,
repository and CI, then seeding the product graph, then configuring policy — if that is a two-week
project, the deal dies before the product is ever judged on quality.

## The regression suite as the first rung that ships code

A test pull request is the lowest-risk code Healer can write: it changes no behaviour, it asserts
something a human already adopted, and a human merges it (013). That makes it a natural first contact
with Healer writing to the repository — before any fix. A team that has merged fifty of Healer's test
pull requests has watched the system's judgement on their codebase without any exposure, which is the
same trust the simulator builds with historical incidents, earned on live work instead.

It also moves adoption earlier. Expectations adopted for the suite are the anchors the fix path needs
later, so by the time a team considers L2 fixes, the product knowledge those fixes depend on already
exists — and was written because it paid off daily, not because onboarding demanded it.

