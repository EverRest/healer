# Patterns

Techniques that recur across specs. Each one is here because it was arrived at independently more
than once — which is the signal that it is a property of the problem rather than a preference.

## Make the unsafe state unrepresentable

The dominant pattern in this repository. A runtime check can be omitted; a shape that cannot express
the dangerous value cannot be omitted, because there is nothing to omit.

| Where | Instead of a check |
|-------|-------------------|
| `ImpactClosure` (004) | Has no confidence parameter at all, and carries a nominal brand — so a filtered view is not assignable where a closure is required, in-process or over HTTP |
| Predicate vocabulary (002) | Existential operators are simply absent, because an existential is satisfied *by* adding an edge |
| `anchor_grant` (005) | An unadopted expectation is not rejected — it is **unnameable**, because 008 references a grant id and nothing else |
| `precedent_candidate` (006) | Has no column for the past root cause, so a precedent cannot be read as a conclusion |
| `fix_eligibility` (006) | A read-only SQL view over three conjuncts, so no write path can open the patch path |
| Egress denial (007) | The run container has **no default route and no DNS**, so `connect()` fails at the syscall — the posture cannot be misconfigured into permitting egress |
| `change_graph_annotation` (008) | Append-only with no update, delete or `active` flag, so removing a deterministically-found edge is unrepresentable |
| Rollback parameters (010) | Accepts only a deployment id from the target's own history, so a forward deploy is not expressible by any caller |
| `fallback_scope` (012) | An enum with one value, so cross-provider fallback for a BYO tenant is not configurable rather than merely defaulted off |
| Capability passing (ADR 0008) | A simulation bundle contains no mutating capability, so the function **cannot be reached** — not "is not called" |
| `golden_issue.split` (011) | Sits on the entry and is never updated, so an incident tuned on cannot be re-published into the sealed benchmark set — there is no row to change |
| `simulation_run.split_scope` (011) | Computed from the entries actually scored rather than declared, and carried into the derivation by a composite foreign key, so a threshold cannot cite a run that touched tuning material |

The counter-pressure is real: each instance costs a type, a column or a module that a boolean would
have covered. Use it where being wrong is silent and expensive. A boolean is fine for a preference.

## Enforce twice where one mechanism is bypassable

Any single mechanism is bypassable by the path that does not go through it — a seed script, a
migration, a support escalation writing a row by hand.

- The autonomy ceiling: a check constraint stops the row existing **and** a clamp makes a row that
  exists anyway ineffective (002).
- "Never wait inside a job": a static lint rule catches the obvious shapes **and** a runtime
  wall-clock budget catches the ones nobody predicted (012).
- Self-adoption of an anchor: the repository credential holds no approval permission **and** an
  adoption naming Healer's own identity is rejected (005).
- A derived threshold: a check constraint refuses a row citing a synthetic, partial, unrepeatable or
  `dev`-scoped run **and** a committed artifact is reconciled against the row in both directions, because
  a file can be hand-written where a row cannot (011 R-20).
- Raising the ceiling: `gate-ceiling` checks grant rows against the ceiling function **and** checks the
  diff for an edit *to* the function, because no data check can see a literal change in code (002 R-15).

The second mechanism exists for the day the first is wrong, not for defence in depth as a slogan.

## Deterministic proposes, model may only reject

Where a model's output would otherwise become a fact:

- Grounding (009): deterministic span matching proposes claim-to-span candidates; a model may reject
  one but cannot introduce one. A claim with no deterministic candidate is ungrounded, with no rescue
  stage.
- Impact analysis (008): the deterministic pass finds edges; a model may annotate but **cannot remove**
  an edge it found.
- Evidence support (006): identifier containment, not entailment. Weaker on purpose — checkable,
  and it catches the failure that actually happens.

Accept lower recall as the price. The safe direction is always the one that does less.

## Fail closed when you cannot determine

Every gate that cannot compute its answer fails (012 R-10). A gate that passes when confused produces
a false record of compliance, which is worse than having no gate — nobody audits a gate that reports
success.

Same shape elsewhere: `UNDETERMINED` classification blocks the patch path (006); an unredactable item
is withheld rather than truncated (003); unparseable test output can never be `PASS` (007).

## A closed list has exactly one authority

Three copies of a closed list is the same failure as having no closed list — this happened literally,
with the boundary crossing shapes enumerated in three divergent places. The rule now:
`012 contracts/runner-protocol.md` is the authority and the requirement that governs it does not
restate its membership.

Corollary: a new fact family gets its own declared shape rather than riding inside a general-purpose
one (C-20). A closed list with an escape hatch is not closed.

## Derive thresholds, do not choose them

Any number that gates autonomy is derived from measurement and recorded with its derivation
(011, stage 0 S0-3, S0-7). Where a minimum protects the derivation itself — `min_real_yield` — it is a
product constant that configuration cannot lower, because a lowerable minimum is lowered by whoever
wants the threshold.

Two additions from the stage-0 review:

- **Measure it on data you did not tune on.** A threshold derived from the incidents the prompts were
  fitted to is optimistic by exactly the amount of fitting, and the consequence of optimism here is a
  higher autonomy level. Hence the sealed benchmark split (C-29). Where data is scarce, seal the scarce
  part for measurement rather than for iteration — the measurement is what gates the product.
- **The consumer must be required to read it.** A threshold that is impossible to fabricate and that
  nothing checks at the moment of use is a gate with no reader (C-30). Ask, for every derived number,
  which mechanism refuses to proceed without it.

Numbers that are merely operational (timeouts, windows, ranking weights) are configuration with
starting values and a note saying what they will be tuned against. Where lowering one is individually
rational and collectively removes a stop rule — a trust floor, a repeat count, an attempt cap, a budget
— it is a clamp, not a default (S0-7).

## Remove the incentive, not just the mistake

Several defects were incentive problems wearing the clothes of a missing field:

- `sent_edited` let the sender classify its own edit — and a material edit resets promotion progress,
  so under-reporting paid. The server now diffs and classifies (009 R-25).
- A configurable promotion threshold is lowered by whoever wants the promotion. It is now a floor a
  tenant may only raise (009 R-23).
- A configurable `min_real_yield` is lowered by whoever wants the threshold (011 R-15).
- The four dangerous unset values are each lowered for a locally reasonable reason — "we draft too few
  answers", "the repeat count is slow", "we escalate too often" — and together they remove every stop
  rule the product has. Each is a clamp (S0-7, C-32).

When a rule can be satisfied more cheaply by misreporting than by complying, fix who reports.

## Structured evidence crosses the boundary, never raw data

The control/execution split (ADR 0001) is only real if what crosses is a closed, versioned schema set
that cannot carry free text. The security review reads the contract, not the intention.
