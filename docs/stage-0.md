# Stage 0 — blockers before specs can be planned

Two questions cannot be answered from a desk. Everything in `v1` sizing depends on them.

## S0-1 · Incident history audit (transl8.ai) — BLOCKING

The golden dataset is the highest-value asset in the project and the benchmark is what every
later threshold is derived from. As of 2026-09-23 we do not know what exists.

Produce a table of the last 12 months of incidents with, per incident:

| Field | Why it matters |
|-------|----------------|
| Symptom and error signature | Fingerprinting design |
| Whether logs still exist | Context Resolver can be tested at all |
| Whether the repo state is recoverable (commit SHA) | Reproduction is possible |
| Whether a fix commit/PR exists | Ground truth for the benchmark |
| Deterministic / load-dependent / data-specific / concurrency / third-party / config | **Reproducibility rate** |
| Was it a code bug at all | Sizes the "is this a code problem" classifier |

**Exit:** a number for *"what share of our incidents are reproducible in a sandbox"*, and at least
20 incidents with recoverable repo state. If the share is low, `v1` scope (D-11) is revisited —
reproduction and TDD fix have nothing to work on.

**How it is produced.** Four of the six columns come out of GitLab with no incident tracker involved,
which is what makes this hours of work rather than weeks:

| Column | Source | Mechanical |
|--------|--------|-----------|
| A fix commit or merge request exists | commit and MR history — `fix:`, hotfix branches, reverts | yes |
| Repo state recoverable | the parent SHA of the fix commit | yes |
| Logs still exist | one retention query per source | yes |
| Symptom and error signature | the incident tracker where one exists, otherwise MR or ticket text | partly |
| Incident class | reading the diagnosis | **no — judgement** |
| Was it a code bug at all | the same reading | **no — judgement** |

So the manual part is two columns over an already-filtered set, not six over twelve months. Start with
the GitLab half: it alone answers whether twenty incidents with recoverable repo state exist, and if that
number is not there, no amount of log retention rescues it — D-11 is revisited regardless.

## S0-2 · Golden dataset construction

Depends on S0-1. Real incidents preferred; synthetic (known bugs injected into real commits) only
to fill gaps, and marked as synthetic — synthetic incidents are easier than life and inflate results.

Scored on behaviour, never on diff similarity to the human patch (a better fix must not be
penalised):

```text
✅ regression test passes
✅ original failure no longer reproduces
✅ pre-existing suite still passes
✅ no unintended behavioural change (impact analysis)
✅ the historical incident did not recur
```

### The benchmark set is sealed (011 FR-011a, R-19)

Every entry declares `split ∈ dev · benchmark`, mandatory and never updated. **The first twenty
adjudicated real incidents go to `benchmark` and stay there.** Prompt, agent and policy iteration draws
on `dev` entries and synthetic material; only a `benchmark` run can derive a threshold, enforced by a
fifth check constraint on `threshold_derivation`.

Without this, the four thresholds that govern autonomy would be measured on the same incidents the
prompts were tuned against — an optimistic false-fix rate raising the level at which an agent writes to a
customer's repository.

Sealing the first twenty rather than splitting the set in half is deliberate: halving twenty destroys
`CHECK (real_denominator >= 20)` and would push S0-1's exit criterion to roughly forty recoverable
incidents. Sealing leaves it exactly where it stands.

An engineer still needs to read a failing benchmark case to understand it, and that is not forbidden —
every run records `split_filter` in its configuration digest and `split_scope` in its result, so exposure
is **visible in the audit**. What closes is the threshold path, not anyone's eyes.

## S0-3 · Thresholds derived from the benchmark

Deliberately unset in the constitution. Set them from S0-2 data, not from intuition:

- **false-fix rate** — merged fixes that passed every gate and did not fix the problem
- **30-day revert rate**
- **per-incident cost ceiling** and per-tenant daily budget
- escalation attempt cap

### Where these four are actually read (002 FR-008a, R-15)

They do not gate anything today, and that is correct: `ACTION_CEILING` gives **no level at all** to
`merge`, `forward_deploy` and `irreversible`, so L2 is held by the absence of a level in a pure function,
not by a number. The thresholds gate the moment that function is **edited** to give `merge` a level.

That moment had no mechanism. `gate-ceiling` validates grant rows *against* the ceiling function, so a
pull request raising the function itself passed every gate in the repository — the product's central
promise, "autonomy is earned by measurement", resting on a code review at the one point where it matters.

So a diff raising a ceiling level must cite a `threshold_derivation` the build can resolve. Since
continuous integration has no control-plane database, publishing a derivation also writes a committed
artifact under `docs/derivations/`; the row stays the authority and the two are reconciled continuously in
both directions. The ceiling gains **no configuration input** — the citation governs the edit, never the
evaluation, because a value that can be read can be misconfigured or cached stale, and the ceiling's
strength is that it is a literal in code.

## S0-4 · First adapter set confirmation

Confirm against transl8.ai reality: VCS (GitLab), runtime, observability stack, CI, test runner,
deploy mechanism. Each one is an adapter and each is scoped work.

**Plus a seventh: a GitHub VCS adapter for Healer's own repository (C-42)**, built after the six below and
never ahead of them — it is dogfooding, not the design partner's path.

**All six are load-bearing; none can be deferred out of v1.** The tempting cut is deploy and runtime, on
the grounds that at L2 Healer never deploys and never observes production. It does not survive contact
with the specs: 010's P1 story is rollback, described there as where v1's MTTR improvement actually comes
from, and its catalogue is rollback, restart, feature-flag disable, scale, queue drain and job retry —
deploy and runtime both. 004's `DeploymentUnit` carries runtime identity, so discovery without a runtime
adapter is blind.

**The tension worth naming.** The diagnosis-to-pull-request path (001 · 003 · 006 · 007 · 008) needs four
adapters and stops at L2, which is the v1 ceiling anyway. The 010 path needs all six, plus an attested
undo, plus production observation — the most infrastructure in the product — and it is the half carrying
the headline number. The cheap half of v1 does not produce the promised metric; the half that does is the
expensive one.

**Order:** observability → VCS → test runner → CI, then deploy + runtime behind a **staging-only**
rollback. Staging first is not a hedge: `autonomy_grant.environment` already scopes a grant to an
environment, so promotion is a grant rather than new machinery, and until the undo has a passing test
`ACTION_CEILING` gives `reversible_remediation` no level at all — rollback cannot be proposed, in any
environment, before its undo is attested. Staging exercises both adapters and earns that attestation at
zero production risk.

## S0-5 · ExpectedBehavior seeding trial

Take one real feature of transl8.ai. Seed expectations from OpenAPI, e2e test names, acceptance
criteria and the existing wiki. Measure: how many drafts were produced, how many a human adopted
unchanged, how long it took. This is the onboarding flow for every future customer — if it takes
weeks, Product Verification never works in practice.

**What failure costs, so the risk is sized before the trial.** No adopted expectation means 006 records
`NO_EXPECTATION` (006 FR-011) and 008's automated fix path refuses. Fail closed, no hole — a poor seeding
result does not make Healer unsafe, it makes it **silent**: the product degrades to "we found something,
you deal with it".

**Exit criterion, in two parts.** Time alone is not enough: three hundred adopted expectations for a
feature nobody breaks is worth nothing.

1. **Coverage, derived from S0-1.** After seeding one feature, count what share of the historical
   incidents touching that feature would have had an adopted expectation covering them. This is not a
   threshold anyone chooses — it is the number that **predicts how often the 008 path will hit
   `NO_EXPECTATION` on the pilot**, which is to say how often the fix path fires at all.
2. **Cost.** One engineer session, hours rather than weeks (005 US3).

**Measure adoption per source class in the same run** — OpenAPI versus e2e test names versus acceptance
criteria versus wiki. It costs nothing extra and pays twice: it says which seeding adapter to build first,
and it is exactly the per-source-class freshness windows S0-7 lists as unset for 005.

**The trap to name now, before it arrives as a pragmatic suggestion.** Once `NO_EXPECTATION` is seen
blocking most issues, the temptation is to auto-adopt the obvious expectations. That is the guess rejected
in C-07, where the AutoSupport allowlist starts empty. Human adoption is not bureaucracy — it is the only
thing that makes an anchor an anchor. A machine that writes its own expectations verifies itself against
itself (constitution II).

## S0-6 · Legal and commercial

- DPA template: customer source code reaching a model provider (D-15, default path)
- Security posture document for procurement: hybrid split, what crosses the boundary, sandbox —
  assembled at [security-posture.md](security-posture.md), which is a consolidation of
  [ADR 0001](adr/0001-hybrid-deployment.md), 012's
  [runner protocol](../specs/012-engineering-foundation/contracts/runner-protocol.md) and the
  [research posture note](../research/wiki/security-posture.md), not new material
- Pricing hypothesis and which budget line it comes from

**The DPA has two shapes, not one.** [ADR 0006](adr/0006-per-tenant-llm-provider.md) states the fact
plainly: when the change agent runs, the customer's source code is in the prompt and reaches a model
provider regardless of where the repository lives, so *"the code never leaves"* would be false.

- **Default (D-15, Healer's provider):** Healer is a sub-processor and the transfer clause is required.
  One contract, fast onboarding.
- **Enterprise (BYO):** inference happens under contracts the customer already signed. The hardest
  procurement question does not get answered — it stops existing. The cost is onboarding friction and,
  per ADR 0006's own consequences, benchmark results that are no longer comparable across tenants.

That sentence belongs in the procurement document as **its own named section**, not a line in the middle.
Said first, it is a trust asset; found by the customer, it ends the deal. The ADR already chose honesty;
the document must not dilute it.

**Pricing already has its meter.** 002 aggregates `agent_run.cost` per tenant and period **without
storing a counter**, so the number policy enforces and the number support reports cannot diverge.
Usage-based per-incident pricing needs no new work in v1. One caution: do not derive the price from the
policy budget, or tightening the budget becomes a way to cut the bill at the cost of diagnosis quality.

## S0-7 · Values the specs deliberately left unset

Every number below is a mechanism that is built and a value that is measured. They are listed here so
that "configuration tuned on the pilot" is a tracked commitment rather than a phrase.

| Spec | Value | Depends on |
|------|-------|-----------|
| 001 | reopen window, stale window, excerpt size limit | S0-1 incident cadence |
| 002 | escalation attempt cap, per-issue and per-tenant budgets, soft-threshold percentages, approval expiry, cooldown windows, rate limits | S0-2 benchmark cost data |
| 003 | ranking term weights, per-source timeouts, time-window defaults, context budget, inclusion cut, follow-up cap | S0-1 |
| 004 | confidence term constants (R-15 gives starting values), drift detection window, staleness window | S0-4 discovery accuracy |
| 005 | freshness windows per source class, retrieval `limit` defaults | S0-5 seeding trial |
| 006 | precedent decay half-life, hypothesis threshold | S0-2 |
| 007 | per-rung repeat counts, rung timeouts, sandbox resource limits | S0-1 reproducibility rate |
| 008 | flakiness `repeat_count`, attempt cap | S0-2 |
| 009 | predicate 2 trust floor, freshness windows, hold limits, reopen window | pilot ticket volume |
| 010 | rate limits, cooldowns, attempt caps, verification window lengths | S0-2 |
| 011 | false-fix rate, 30-day revert rate, per-incident cost ceiling | **S0-2, and these four gate autonomy (C-05)** |

There was a row here reading *"masking rejection threshold (SC-009)"* for 008. **No such threshold exists,
and none should.** 008 FR-014 detects masking by deterministic diff inspection and FR-015 makes the
rejection a hard refusal; SC-009 is a fixture-set outcome — zero masking patches approved without human
review — not a knob. Calling it a threshold in a tracking table is how, in six months, someone makes it
one.

**Every unset value ships with a starting value chosen to fail closed.** Today the precedent exists in
exactly one place: 004 R-15 names its confidence constants and gives them starting values to be tuned once
discovery accuracy is measured. That is the rule, not the exception. Tight budgets, low caps, high trust
floors: the first pilot run should over-escalate to humans, never over-act. A value nobody has set is not
neutral — it is whatever the code does when the column is null, decided by accident.

**But the rows are not equivalent, and the difference is mechanical.** Where a wrong value is merely
annoying, a starting value is enough: 001's windows, 003's weights and timeouts, 004's constants, 005's
freshness windows, 006's decay half-life. Where a wrong value is **dangerous**, the value needs a clamp —
a floor or cap configuration cannot cross, written the way `CHECK (real_denominator >= 20)` is written, as
a literal with a constant in code and a test asserting the two agree:

| Spec | Value | Why a clamp and not a default |
|------|-------|-------------------------------|
| 009 | predicate 2 trust floor | lowered to nothing, drafts cite whatever is cheapest to retrieve |
| 007 | per-rung repeat counts | one flaky `PASS` is a false reproduction, and the whole fix chain stands on it |
| 002 | escalation attempt cap, per-issue and per-tenant budgets | the cost ceiling is also a stop rule; removing the stop rule is a configuration change |
| 006 | hypothesis threshold | a floor near zero turns "diagnosis" into "first plausible story" |

**The four in 011 are different again.** They govern whether autonomy may be raised, they may only be
derived from a run with zero synthetic incidents **and zero `dev` entries** (R-19), and the minimum
scored-real denominator is a product constant of 20 that configuration cannot lower (011 R-15). If S0-1
yields fewer than 20 reproducible, adjudicated incidents, no threshold exists and L2 stands. That is the
designed outcome, not a blocker to work around.

## S0-8 · Knowledge embeddings and the boundary (ADR 0010) — RESOLVED by C-36

005 builds the knowledge index in the control plane, and an embedding is a model call over a document
that `knowledge_ref` says does not cross. Under C-33 the call belongs where the document lives. Two
honest options: embed in the runner and send vectors as their own declared shape, or admit document text
as a declared shape for documents the customer marks shareable. Vectors are derived customer content and
partially invertible, so neither is free. **Resolved (C-36):** no vector index over customer documents in v1; 005
retrieval runs on its lexical and structured paths.
