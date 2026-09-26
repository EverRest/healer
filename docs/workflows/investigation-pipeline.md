# The investigation pipeline

How the thirteen features compose into one flow. Each spec owns a stage; this page owns the seams,
because the seams are where every defect in the first analyze pass lived.

## The shape

```text
                          signal / report / alert
                                    │
     ┌──────────────────────────────▼──────────────────────────────┐
     │  001  fingerprint → Issue (one, not twelve thousand)        │
     └──────────────────────────────┬──────────────────────────────┘
                                    │
     ┌──────────────────────────────▼──────────────────────────────┐
     │  003  Context Resolver — runs in the EXECUTION plane        │
     │       parallel collection · redaction · collection gaps     │
     │       only closed shapes cross the boundary                 │
     └──────────────────────────────┬──────────────────────────────┘
                                    │  ContextSnapshot + Evidence
     ┌──────────────────────────────▼──────────────────────────────┐
     │  006  is this a code problem?  ← runs FIRST, fails closed   │
     │       ├── no  → 010 reversible remediation, or human        │
     │       └── yes → hypotheses vs adopted ExpectedBehavior (005)│
     └──────────────────────────────┬──────────────────────────────┘
                                    │  fix_eligibility (a view, read by 002 AND 008)
     ┌──────────────────────────────▼──────────────────────────────┐
     │  007  reproduction ladder, cheapest rung first              │
     │       PASS │ FAIL │ INCONCLUSIVE → human                    │
     └──────────────────────────────┬──────────────────────────────┘
                                    │  change_eligibility
     ┌──────────────────────────────▼──────────────────────────────┐
     │  008  impact analysis (004) → ChangePlan → policy (002)      │
     │       anchor re-resolved from 005, independently             │
     │       RED → fix → GREEN → verifier → pull request            │
     │       agents, applier and verifier run IN THE RUNNER (0010)  │
     │       TERMINAL: PR_OPENED. No merge, ever, in this release   │
     └─────────────────────────────────────────────────────────────┘

   013 Regression suite feeds 001 from the other side: adopted expectations (005) become
   tests, the customer's CI runs them, a default-branch failure is a `regression` issue.
   009 AutoSupport and 011 Simulator read the same core; 012 is underneath all of it.
```

## The seams, and what holds each one

**001 → 003.** The issue exists in the control plane; collection happens in the customer's. What
crosses is the closed shape set in `012 contracts/runner-protocol.md` — never a raw log body. An item
redaction cannot clear is **withheld with a recorded gap**, not truncated.

**003 → 006.** Collection gaps are evidence records. That is what lets 006 persist an honest
`INSUFFICIENT_CONTEXT`, since 001 FR-009 forbids a conclusion with no evidence. Without the gap
records, "I don't know" would be unstorable and the system would be forced to guess.

**006 → 002.** `fix_eligibility` is a read-only view over three conjuncts. It is read in **two**
places on purpose (C-08): policy carries the facts in `DecisionInput`, and 008 guards on the view at
loop entry. One reader is one place to forget.

**006 → 007.** The rung vocabulary is frozen in exactly one place. The directive carries a
`suggestedRung` (a hint) and a `maxRung` (a ceiling); the engine always starts at `unit`, so
"stop at the cheapest rung that reproduces" stays verifiable.

**007 → 008.** What crosses is the **recipe**, not the data (C-04). An anonymised extract has no
recipe, so 008 attempts a synthetic equivalent and routes to a human if it does not reproduce (C-23).
The intermittency rate travels with it, as the rate of the rung that reproduced — not an aggregate.

**005 → 008.** The anchor is named by `anchor_grant_id` and nothing else. 008 re-queries 005 through a
**non-agent** resolver and explicitly does not trust 006's claim that an expectation was violated —
that claim is an earlier step in the same chain (constitution II).

**004 → 008.** Impact analysis consumes an `ImpactClosure`. An unconfirmed edge may only **widen** the
radius, never narrow it, so being wrong about the graph costs extra human review rather than a
permitted action.

**008 → 001.** `PR_OPENED` is terminal. `ChangeVerifiedInProduction` is **reserved and unemitted in
v1**, because at L2 Healer neither merges nor deploys and therefore never observes its own change in
production.

**Inference follows the source (ADR 0010).** A model call runs where its inputs live. The change agent,
the applier, the masking analyser and the verifier execute in the runner; the control plane keeps the
state machine, policy, the lease and every table, and receives `change_plan_proposal`,
`masking_candidate`, `verification_verdict`, `test_result`, `pull_request_ref` and `agent_run_report`.
The patch never crosses. What holds it: the closed shape set has no field that could carry a hunk.

**005 → 013 → 001.** A test exists only for an expectation with an active `anchor_grant` — adopted by a
human approving a pull request — and asserts that expectation's constraints. Its failure on the default
branch creates a `regression` issue whose candidate anchor was adopted before the failure, which is the
order 008 requires. A failure on a pull-request branch creates nothing: it belongs to that pull request.

**013 → CI.** Selection may widen and never narrow: an unknown path, an uncomputable closure or an
unreachable Healer all select the full suite.

**010 → 001 → 009.** This is the only v1 path to `IssueResolved`: a verified reversible remediation,
or a human close. 009 releases held tickets only on `remediated` or `fixed` with non-empty
verification evidence — a human close escalates instead, because it carries no evidence to cite.

## What runs in parallel and what does not

Parallel: evidence collection across sources (003), and only that.

Serial, each verified before the next: reproduction → regression test → RED → fix → GREEN → broader
tests → verifier → pull request. And **no step waits inside a job** — every external wait is a
persisted state plus an inbound callback (ADR 0003).

## Where a human always appears

- `INCONCLUSIVE` reproduction, `UNKNOWN` diagnosis, `INSUFFICIENT_CONTEXT` support answer
- `knowledge_drift` — only a person knows whether the document is stale or the code is wrong
- Every merge, in this release, without exception
- Adoption of an `ExpectedBehavior`, through code review — including every regression scenario (013)
- Every test pull request from the regression suite, like every fix
- Any policy decision returning `REQUIRE_APPROVAL`, and any expired approval
- After the attempt cap, carrying what was ruled out and why

## Cost and stop rules

Every AI path has a per-issue and per-tenant budget with a declared degradation order, recorded as a
`budget_degradation` evidence record when applied (002). Escalation to a stronger tier is capped;
at the cap the accumulated evidence and rejected hypotheses go to a human, which is useful output
rather than a failure.
