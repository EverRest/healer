# Research wiki — log

## 2026-09-27 — a real concurrency bug, and the deployment gap nobody had named

**001's Phase 3 (US1, deduplication and ingestion) landed complete**, T015 through T026. The load
check (T026) did what a load check is for: a race flagged as "narrow" when T018 shipped
(`findOpenByFingerprint` then `create` is a check-then-act, not one atomic operation) turned out
to fragment a burst of a brand-new fingerprint's first arrivals into as many as sixteen separate
issues under real concurrency — not narrow at all. Fixed with a unique partial index scoped to
genuinely open states, plus a retry-as-attach on the losing side of the race. `plan.md` also
turned out to name a "design signal rate" and "the plan's latency budget" that plan.md itself
never defines — a real gap in the spec chain, not a value anyone deferred on purpose; added to
`docs/stage-0.md` S0-7's tracked list, which had missed it entirely.

**The deployment gap.** Asked whether Healer's own control-plane deployment, automated
smoke/regression checks against a running environment, and release automation are recorded
anywhere. They are not. [operating-healer.md](operating-healer.md) covers observing a *running*
control plane; nothing covers how it gets to be running at all beyond `make ci` on push/PR. 012
FR-052 only forbids Kubernetes and Terraform — it names no positive target. Playwright's one use
in this codebase is a **product capability** (client-side reproduction, 007/008), not a check
against our own environments. Recorded as a new section of `operating-healer.md` and flagged in
`QUESTIONS.md` rather than invented here — picking a hosting target and a release process is
new-infrastructure territory, an ADR conversation, not a wiki edit.

## 2026-09-26 — the crossing nobody described, a regression suite, and agents under the gates

**How it started.** A set of plain questions from the owner — how do we debug production without logs,
where does the runner run and what does it do, should we use a router or a framework, can development be
automated — turned up the most serious defect since the stage-0 review.

**The defect: an unshaped crossing of customer source.** The runner contract said file contents never
cross. The security posture said source is in the change agent's prompt. The change agent lived in the
control plane. Each statement was true; together they required a path no specification described.
Resolved as ADR 0010, *inference follows the source*: model calls that read source run in the runner,
the control plane orchestrates, the patch never crosses. Constitution 1.2.0. New failure mode §12.

**Rejected, with reasons in ADR 0010:** a bounded `code_excerpt` shape (Healer processes source in
transit, and the bound erodes); a Healer inference gateway (brings the source back through us); moving
the whole loop to the runner (policy and audit leave infrastructure we can observe).

**Agent-driven development (012 US10, ADR 0011).** Coding agents implement one task per pull request
under two new gates — scope and red-first — with identity from the host's bot flag and merge rights in a
ruleset read for drift. Specify, clarify and analyze stay human, because every analyze finding so far sat
at a seam. New failure mode §14.

**Regression suite (013).** The owner proposed describing scenarios for every page and API in a wiki
and testing against them. Adopted in a form that keeps constitution II: a scenario is an adopted
`ExpectedBehavior` in 005's repository markdown, a test must assert its constraint, a default-branch
failure is a `regression` issue in the one pipeline, and selection may widen but never narrow. New
failure modes §13 and §15.

**A seam defect caught in our own work.** 013's first draft said merging an expectation document is not
adoption. 005 R-16 and C-06 say approval of that pull request *is* adoption. Corrected before any task
depended on it — the second seam defect of the day, and the argument in
[agent-driven-development](agent-driven-development.md) for keeping seams human.

**Closed questions (C-36..C-42):** no vectors over customer documents in v1; Healer's repository on
GitHub with a GitHub adapter in v1 for dogfooding; provider keys rotated by hand; the runner ships with
Docker Compose; merge-rights ruleset read on a schedule; our telemetry to Grafana Cloud through one
collector with tenant identifiers hashed, self-hosted as the planned next step.

**Evaluated and not taken:** System One models (TypeSafe Jev) — see
[llm-stack-choices](llm-stack-choices.md). OpenRouter stays in the eval harness only; no agent framework.

**Lint findings, fixed in place:** [knowledge-model](knowledge-model.md) still listed "whatever wiki
they have" as a cold-start source, which C-06 had already ruled out; the
[security posture](security-posture.md) page predated ADR 0010.

**Open:** nothing blocking. S0-1 still sizes v1.

## 2026-09-24 — stage-0 review: the thresholds had no reader

Walked the seven stage-0 items one at a time. Four decisions, C-29..C-32, and one correction. Totals:
366 FR, 138 SC, 1 166 tasks, 235 research entries, 587 quickstart scenarios; FR coverage 366/366, 988
cross-spec requirement references, 112 task references, every internal link resolving.

**The finding worth keeping.** 011 makes an autonomy-governing threshold impossible to fabricate — a
composite foreign key and four check constraints, so a derivation citing a synthetic, partial or
unrepeatable run cannot be inserted. Careful work. Then `threshold_derivation` turned out to be referenced
only inside 011 and once in 010, and never by 002, which owns `autonomy_grant`.

At first that looked like a hole and was not: in this release `ACTION_CEILING` gives `merge`,
`forward_deploy` and `irreversible` **no level at all**, so L2 is held by the absence of a level in a pure
function, not by a number. There was nothing for a threshold to gate. The real gap was one step further
out: the thresholds gate the moment that function is *edited*, and `gate-ceiling` validates grant rows
*against* the function while nothing looks at the function itself. A pull request giving `merge` a level
passed every gate in the repository. The product's central promise — autonomy is earned by measurement —
rested on a code review at the single point where it decides anything.

Same failure shape as the analyze pass found twice (a gate with no reader), this time sitting on the
promise the product is sold on. The distance between "impossible to fabricate" and "required to be read"
is the whole lesson.

**The second finding: the measurement was tuned on its own test set.** No `split`, no `holdout` anywhere
in 011. Prompts iterate on the golden dataset, thresholds are derived from the golden dataset, and the
false-fix rate comes back optimistic by exactly the amount of iteration — with a higher autonomy level as
the consequence. Sealing the first twenty adjudicated real incidents as `benchmark` costs nothing against
S0-1's exit criterion, where a conventional half split would have pushed it from twenty recoverable
incidents to about forty.

The split lives on the entry rather than on dataset membership. Membership-level split would let one
incident be `dev` in version 3 and `benchmark` in version 4 — laundering, and exactly the kind of thing
nobody would notice in a year.

**Where I was wrong, checked before proposing.** I went into S0-4 intending to cut two adapters: at L2
Healer never deploys and never observes production, so deploy and runtime looked like gates with no
reader. Wrong. 010's P1 story is rollback, described in its own spec as where v1's MTTR improvement comes
from, and 004's `DeploymentUnit` carries runtime identity. All six are load-bearing. The useful output was
not a cut but the tension: the cheap half of v1 does not produce the promised number, and the half that
does needs the most infrastructure in the product.

**A small defect in our own tracking table.** S0-7 listed a "masking rejection threshold" for 008. There
is no such threshold and there must not be — FR-014 is deterministic diff inspection, FR-015 a hard
refusal, SC-009 a fixture outcome. Calling something a threshold in a table of things to tune is how it
becomes tunable in six months.

**The pass that followed, on the documents themselves,** turned up a stale glossary entry nobody had
noticed: `Rung` still described a single reproduction ladder, after C-24 split it into two a day earlier. By
this repository's own rule — a term used differently in two specs is a defect — that is a defect, and it was
found by asking what the day's decisions had made untrue, rather than by reading the specs again. Worth
repeating as a habit: after a decision lands, the question is not "is the spec consistent" but "which
sentence elsewhere did this just falsify".

**What the four dangerous unset values have in common.** Each is lowered for a locally reasonable reason —
"we draft too few answers", "the repeat count makes reproduction slow", "we escalate too often", "the
diagnosis threshold is too strict" — and together they are every stop rule the product has. So each gets
a clamp rather than a default, written the way `min_real_yield` is written. The pattern was already in
`patterns.md` under "remove the incentive, not just the mistake"; what was missing was applying it to
numbers rather than to reports.

## 2026-09-24 — analyze pass, and the browser that was missing

`/speckit-analyze` across all twelve specs: ≈110 findings, 10 CRITICAL, ~47 HIGH, resolved as
C-08..C-28. Final state: 1 151 tasks, 232 research entries, 29 contract documents; 927 cross-spec
requirement references, 111 task references and 439 internal links all resolve.

**The honest headline: every spec was internally complete, and all the damage was at the seams.**
FR→task 342/342. Every success criterion had work, every quickstart scenario had a task, zero orphan
tasks in any of the twelve. Twelve agents each wrote a good spec; what none of them could see was the
other eleven.

### Four shapes the failures took

**A guarantee that was prose rather than mechanism.** `ImpactClosure` and `KnownSubgraph` had the same
members — and TypeScript is structurally typed, so "accepted by no predicate" was a comment. The four
check constraints enforcing C-05 referenced columns of *another table*, which Postgres cannot do.
`gate-no-send` was scoped to the support packages while 009's adapters live under `integrations/` by
design, so the gate was defeatable by adding an adapter in the place the architecture told you to put it.

**A research decision that never reached the data model or tasks.** Mostly my own late fixes: the
declaration columns on `remediation_target`, the counters on `rung_attempt`, the promotion threshold's
constraint, `min_real_yield`. Each described, none implementable.

**A gate with no reader.** `fix_eligibility` and `change_eligibility` — the two views that close the
patch path — were read by nobody. 002's closed `DecisionInput` had no field for them and 008 never
mentioned them. And 008's fix-loop contract had **no reproduction state at all**: impact analysis and
the test write proceeded with nothing requiring the bug to have been reproduced, in the document
designated to prove Principle III.

**An incentive problem wearing the clothes of a missing field.** `sent_edited` let the sender classify
its own edit, and a material edit resets promotion progress — so under-reporting paid. A configurable
promotion threshold gets lowered by whoever wants the promotion. A configurable `min_real_yield` gets
lowered by whoever wants the threshold. All three now have the reporting or the floor moved out of
reach of the party with the incentive.

### My own chain of consequences

I decided 008 does not emit `ChangeVerifiedInProduction`, because at L2 Healer neither merges nor
deploys and therefore never observes its own change in production. That was right. What I failed to
trace: 010 emitted nothing, no human-close path existed, so **nothing in v1 emitted `IssueResolved`**
— and every held support ticket reached its deadline and escalated instead of being answered. The
naive repair would have been to fire the event on merge, which tells fifty customers a problem is
fixed before anything checked.

### The browser that was missing

Asked whether Playwright is needed to reproduce a bug from logs. Checking revealed that **Playwright
appears nowhere in any of the twelve specs, the constitution or docs** — the ladder had six rungs and
none was a browser — while v1 targets a monorepo with a frontend and the product's most compelling
demo is "click Pay, the spinner never stops".

The answer is not one ladder with browser rungs appended. Two ladders, selected by **where the symptom
is observable** rather than by who reported it:

- For a log-derived endpoint error, a browser is the wrong instrument: the log already gives endpoint,
  method, signature, frames and a trace id. Driving a browser means booting a frontend to arrive at an
  HTTP request the engine could have made directly.
- For a browser-only symptom, `unit` and `request` cannot produce a `FAIL` **in principle**, so one
  ladder would waste two rungs by construction before reaching an instrument that can see anything.

Two cheap consequences fell out. A component test leads the client ladder, because a large share of
"the spinner never stops" is a state machine that never leaves `loading` — milliseconds, no browser, no
build. And intake asking the reporting system for a trace identifier moves a report from the browser
rung to a request replay, which is the cheapest cost control in the whole reproduction path.

Playwright's other role survives unchanged and is now explicit: a change touching a component in a
declared user flow re-runs that flow's journey as verification, independently of how the issue was
reproduced. A server-side fix that makes an endpoint return 200 can still leave a spinner turning, and
the endpoint regression test would never see it.

### Also worth recording

All fifteen questions put to the owner were answered with the recommended option. That is a signal
worth acting on: the next review round should be presented as decisions with reasoning rather than as
questions, and escalate only where the recommendation is genuinely uncertain.

**Open**: nothing in the artefacts. Stage 0 S0-1 — the incident history audit — still blocks realistic
sizing, and three thresholds remain deliberately unset pending the benchmark.

## 2026-09-24 — tasks complete, and thirty gaps the tasks exposed

1 094 tasks across 121 phases. 866 cross-spec requirement references, 103 cross-spec task references
and 387 internal links all resolve; 11 OpenAPI documents valid; task numbering contiguous in all
twelve files with no duplicates.

**Writing tasks is where the specs got tested.** Five agents each reported the places a plan had left
something unspecified — around thirty in total. That is the real value of this step: a requirement
that cannot be turned into a task is a requirement that was not finished, and it is much cheaper to
discover that now than while implementing.

The ones worth remembering:

**`ChangeVerifiedInProduction` had no emitter, and could not have one.** It was listed as published by
008 and consumed by 001, 009 and 011 — but at L2 Healer never merges and never deploys, so it never
observes the production behaviour of its own change. 009 releases held customer tickets on exactly
that event. Resolved by removing it from v1: `IssueResolved` comes only from a verified reversible
remediation or from a human. 011's revert-rate metric reports unavailable rather than zero. This was
the most dangerous gap found in the whole session, because the naive fix — emitting it on merge —
would have told customers a problem was fixed while nothing had verified it.

**Evidence support had no mechanism**, only a requirement that citing is not grounding. The two
obvious implementations are both wrong: a model judging support is self-review, and prose matching
accepts a citation that shares vocabulary while saying the opposite. Resolved as deterministic
**referent containment** — every identifier the claim names must appear in the cited evidence's
structured payload. Weaker than entailment, and deliberately so: it is checkable, and it catches the
failure that actually happens. It cannot catch a wrong inference from the right referents, which is
what the adopted expectation and the independent verifier are for.

**`workload.restart` had no undo**, on the reasoning that a restart is harmless. A restart that does
not come back is precisely the failure mode, so its undo is now a scale-up to the healthy replica
count observed in the precondition, and the admission test exercises that.

**`job.retry` and `feature_flag.disable` had no declared bounds.** Retry without an idempotency
assertion can double-charge a customer; flag disable without an allowlist can turn off
authentication. Both are now target declarations, and an action is simply *absent* for a target whose
bounds are unset rather than guarded at call time.

**Recurring shape**: several gaps were an incentive problem rather than a missing field. `sent_edited`
let the sender classify its own edit — and a material edit resets promotion progress, so the sender
had a reason to under-report. Now the server diffs and classifies. `category_eligibility.threshold`
and `min_real_yield` were configurable, which means lowerable by whoever wants the promotion or the
threshold. Both are now product constants; one may be raised, never lowered.

**Deferred honestly**: every numeric value the specs left unset is now tracked in stage 0 S0-7 with
what it depends on. The four in 011 are called out separately because they gate autonomy, may only be
derived from a run with zero synthetic incidents, and rest on a scored-real denominator of at least 20
that configuration cannot lower.

**Open**: nothing in the artefacts. S0-1 still blocks realistic sizing.

## 2026-09-24 — twelve plan sets complete

189 research entries, 27 contract documents, 563 quickstart scenarios, 109 markdown files.
684 cross-spec references and 145 internal links verified; 11 OpenAPI documents valid with no
duplicate path keys at any nesting level.

**The pattern that emerged, unprompted, in five independent agents**: make the unsafe state
*unrepresentable* rather than forbidden. It appeared six times:

- **004** — two non-interchangeable result types. `ImpactClosure` has no confidence parameter and is
  the only type any policy input accepts; the predicate vocabulary over it excludes existentials,
  because an existential is satisfied *by* adding an edge. C-03's asymmetry is enforced by the type
  system rather than by a check.
- **005** — anchor eligibility is a row (`anchor_grant`), not a state check. 008 references the grant
  id, never the expectation id, so an unadopted expectation is not rejected — it is unnameable.
- **006** — fix eligibility is a read-only SQL view over three conjuncts, so no write path can open
  the patch path. And `precedent_candidate` has no column for the past root cause at all.
- **007** — default-deny egress is an *absent route*, not a filter: the run container has no default
  route and no DNS, so `connect()` fails at the syscall and the posture cannot be misconfigured.
- **008** — model interpretation lives in an append-only annotation table with no update, delete or
  `active` flag, making removal of a deterministically-found edge unrepresentable.
- **010** — rollback's parameter schema accepts only a deployment id resolved from the target's own
  history, so a forward deploy is not expressible by any caller.

This was not in any of the briefs. Five agents reached for the same technique because the
constitution's non-negotiable principles are the kind of thing a runtime check eventually fails to
carry.

**Seven real contradictions found and fixed**, all in artefacts written earlier in the session:

1. **D-10 read naively would breach the BYO contract during evaluation** — the same trap as 012
   FR-046, now in the benchmark. Amended: evaluation routing resolves within the tenant's declared
   provider scope, and the routing used is part of the run's configuration digest.
2. **012's closed crossing list had no shape for a graph fact**, making 004 FR-021 unimplementable.
   Four shapes added. Reusing `tool_output_summary` would have reopened the free-form channel the
   contract exists to close.
3. **The same closed list existed in three divergent versions** — 012 FR-022, the runner protocol
   contract, and 003 FR-006. Three copies of a closed list is the same failure as no closed list;
   the contract document is now the single authority and FR-022 no longer restates it.
4. **001's evidence type enum was missing three members** that consumers require —
   `budget_degradation` (002), `graph_fact` (004) — plus `classification` in the conclusion-type
   enum (006). Added, with an explicit rule that the set is owned by 001 and consumers must ask
   rather than overload `tool_output_summary`.
5. **009 FR-011 made C-07 unimplementable**: it returned `NEEDS_HUMAN` before drafting, so a category
   could never accumulate the unedited sends that would promote it. Blocked and not-yet-allowlisted
   are now different outcomes.
6. **009 referenced an issue state that does not exist** ("merged"). 001's `merged` means two issues
   were merged together, and 008 publishes no merge event at all.
7. **012 FR-001 and 012 plan.md disagreed about the package layout**; ADR 0004 had no approved
   extension list, so the dependency gate had nothing to check.

**ADR 0008** written for capability passing, which turned out to be a cross-cutting pattern rather
than one feature's mechanism: it is how simulation cannot mutate (011), how the investigator cannot
publish (006), and how "permissions are what tools grant" becomes concrete.

**Open**: nothing in the plans. Stage 0 S0-1 still blocks realistic sizing, and three thresholds
remain deliberately unset pending the benchmark.

## 2026-09-24 — clarifications closed, planning started

Seven `[NEEDS CLARIFICATION]` markers resolved (C-01..C-07). **Four dissolved rather than being
answered** — once the asymmetry or the ownership was made explicit, the question stopped needing a
value:

- **C-03** asked for a minimum provenance strength before an unconfirmed graph edge may feed a
  policy predicate. But the two errors cost differently: an unconfirmed edge that *widens* blast
  radius costs extra human review; one that *narrows* it permits an action that should have been
  blocked. A single threshold treats them as equal. The rule became asymmetric instead, and the
  query layer is designed so the unsafe direction is not expressible.
- **C-04** asked how long to retain anonymised reproduction fixtures. But a fixture a regression
  test needs must live in the customer's repository anyway, or their CI cannot run the test. A
  second copy in Healer adds derived customer data at rest and a DPA clause while buying nothing.
- **C-06** asked whether a Confluence adapter belongs in v1. Repository markdown supplies freshness
  and authorship from git, and adoption of an `ExpectedBehavior` passes through code review — which
  *is* the human adoption gate the anchor requires. A hosted wiki supplies none of the three.
- **C-07** asked which support categories to seed. Seeding by judgement is the guess rejected
  everywhere else; the allowlist starts empty and categories are promoted by measured unedited
  sends. Costs almost nothing, because Healer never sends.

**C-05 has a consequence worth stating plainly**: no autonomy-governing threshold may be derived
from any run containing synthetic incidents. If the S0-1 audit yields too few real incidents, the
correct outcome is that no threshold exists and the L2 ceiling stands. That is not a process
failure — it is the honest answer, and it already matches D-12.

Planning began with 012 (foundation) and 001 (evidence substrate), which set the pattern: research
as Decision / Rationale / Alternatives, data models ending in invariants, quickstarts whose
scenarios include the ones that must fail. Remaining ten planned in parallel.

**One self-inflicted error worth recording**: the first 001 OpenAPI draft declared
`/issues/{issueId}` twice — YAML parses it happily and the second block silently overwrote the
first, removing the read endpoint. A duplicate-key check now runs across all contract files.

## 2026-09-23 — twelve specifications written

339 functional requirements, 133 success criteria across 12 specs. 174 cross-spec references and
42 internal links verified — none broken. Numbering contiguous, no duplicates, all mandatory
sections present.

**Five contradictions surfaced while writing, all resolved rather than deferred:**

1. **"No deploy" collided with autonomous rollback.** The autonomy ceiling forbade deploys while
   D-14 permits autonomous rollback — which is a deploy operation. Resolved: the ceiling forbids
   *forward* deploys; rollback to a previously deployed version is a reversible remediation.
2. **Threshold count disagreed across three documents.** The constitution said two thresholds were
   unset; stage 0 and the decision record listed four. Aligned on four.
3. **The code-problem classifier was placed after reproduction.** Economically it must run before
   hypothesis generation — otherwise sandbox time is spent on a Redis outage. Moved, owner 006.
4. **Governance cited a module list the constitution never contained.** Module boundaries are
   enforced by patterns rather than a name list, so a new module needs no lint edit; only the
   documentation half of the rule survives.
5. **`KnowledgeDrift` had no home.** The constitution and wiki both name it as an issue type, but
   001 enumerated five kinds without it. Added as a sixth kind with its own terminal rule — drift
   ends at human adjudication and never enters reproduction or the change path, because only a
   person knows whether the document is stale or the code is wrong.

**One trap nobody had seen**: for a tenant using their own model access (D-15), an ordinary
retry-with-fallback would silently route their source code to Healer's provider — breaching the
exact contract that made them adoptable. Now explicitly forbidden and measured under induced
provider failure.

**Seven open clarifications**, all genuinely blocked on stage 0 rather than on preference: the
Confluence adapter (needs S0-4), the AutoSupport category allowlist (needs a ticket breakdown),
anonymised fixture retention (a DPA-level commitment), maximum synthetic share in a threshold-
setting benchmark run (needs S0-1's yield), minimum provenance strength for an unconfirmed graph
edge feeding a policy predicate, and two about runner packaging — distribution format and
compatibility window.

## 2026-09-23 — design review and constitution

Brainstorm reviewed across nine parts. Architecture was strong; the product boundary had never
been drawn, and every part added scope. Twenty-three decisions taken, recorded in
[docs/decisions.md](../../docs/decisions.md).

**Structural problems found in the brainstorm, and how they were resolved:**

1. **Circular verification** appeared in three separate places — the regression test verified
   against the diagnosis that wrote it, answer citations against the answer that chose them, and
   the adversarial reviewer against *"the reported root cause"*, which is the first model's
   conclusion. Every gate could report PASS while the system was confidently wrong. Resolved as
   constitution principle II: verification anchors only on adopted `ExpectedBehavior`, raw
   evidence, human-written tests, or production signal. The reviewer gained `REJECT_DIAGNOSIS`.

2. **Wiki staleness as a production risk.** Making the product wiki a verification gate meant a
   stale entry could block correct fixes or restore obsolete behaviour. Resolved with a trust
   hierarchy that inverts by question: the wiki is never authority on what the code does, only on
   what it should do. Disagreement becomes a `KnowledgeDrift` issue for a human.

3. **Safety mechanisms scheduled after the capability they protect.** Policy Engine at phase 14
   and 21, evaluation at 19–20, simulator at 24 — yet phases 3, 5 and 8 had exit criteria that
   required policy, and phases 2, 6, 7 and 8 required the benchmark dataset. Those phases could
   not have passed their own gates. Policy, Evidence and the eval harness moved to the front.

4. **`Evidence` and `ExpectedBehavior` were missing from the domain model** despite the
   brainstorm's own summary naming evidence as the centre of the architecture.

5. **Prompt injection through logs** was absent entirely — an agent with production read and
   repository write, assembling context from attacker-influenceable sources.

**Rejected options worth recording:**

- *AutoSupport as a later phase* (original: phase 15). Rejected — it runs on the same core with no
  sandbox and supplies the only cheap labelled evaluation data available.
- *Read-only v1* (my recommendation). Rejected by the owner in favour of including TDD fix and PR.
  Accepted on the grounds that transl8.ai as design partner means both sides are under our control.
- *Temporal for durable workflows.* Deferred — replaced by the rule that no job waits, which keeps
  BullMQ sufficient and the upgrade cheap.
- *Diff similarity to the human patch as benchmark ground truth.* Rejected — it penalises fixes
  better than the original.
- *MTTR as headline metric.* Rejected — at L2 humans merge and deploy, so the credit is not ours.

**Open:** incident history audit for transl8.ai (S0-1) blocks realistic sizing of v1. If the share
of reproducible incidents turns out to be low, the TDD-fix half of v1 has little to work on.
