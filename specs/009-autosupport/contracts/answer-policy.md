# Contract: AnswerPolicy

`AnswerPolicy` is a **rule set evaluated by 002's engine**, not a second engine (002 FR-001,
FR-002, FR-004). It is deterministic and versioned; identical inputs produce identical outcomes, and
every decision records the rule version used.

**Model-reported confidence is not an input to any predicate** (FR-005, 002 FR-003). It is recorded
on the `agent_run` and may be used only to order a human review queue or break a tie between
otherwise equally admissible candidates (FR-007). Two drafts differing only in declared confidence
receive the same outcome (SC-003).

## Outcomes

```text
AUTO_REPLY            all eight predicates true — publish a draft, do not send
NEEDS_HUMAN           a predicate failed on a decidable ground, or a hold expired, or budget ran out
INSUFFICIENT_CONTEXT  nothing supports the answer — the draft is discarded, retrieval trace attached
held                  transient; waiting on a linked issue (FR-018)
```

There is no hedged outcome. `AUTO_REPLY` with a caveat is not representable (US-2 scenario 4).

## Evaluation order

Order matters for cost, not only for correctness: a blocked category must terminate **before any
drafting step runs**, so SC-007 is measured as the absence of drafting cost on those tickets rather
than as a flag set afterwards (R-04).

```text
1  classify category                        deterministic classifier + candidates
2  blocked-topic check                      → NEEDS_HUMAN, terminate. No draft is created.
2a language-support check                   → NEEDS_HUMAN, terminate. Reporter language outside the
                                             declared scanner set (FR-012a, R-18). No draft is created.
3  hold check                               → held, terminate for now. No draft is created.
4  retrieval                                005, tenant-scoped by signature (R-10)
5  draft assembly                           agent run 1 — text with {{fact:…}} slots
6  claim decomposition                      agent run 2 — draft text only, no rationale
7  structured-fact binding + token scan      deterministic
8  independent grounding                     deterministic proposes, model may only reject
9  finalisation re-verification              tenant ownership + pinned citation versions
10 policy evaluation                         the eight predicates, by 002's engine
```

Steps 5–9 run for a **non-allowlisted** category as well; the outcome is `NEEDS_HUMAN` and the draft
is attached as a proposal for the human handling the ticket. That is what makes the C-07 promotion
measurement possible (R-15). Steps 5–9 do **not** run for a blocked category.

## The eight predicates

Every one must be true for `AUTO_REPLY`; failure of any produces `NEEDS_HUMAN` or
`INSUFFICIENT_CONTEXT` (FR-006). All eight results are recorded, not only the failing one
(US-2 scenario 5).

| # | Predicate | True when | Reads | Failure outcome |
|---|---|---|---|---|
| 1 | `claims_have_citations` | every `draft_claim` maps to ≥ 1 `citation` | claims, citations | `INSUFFICIENT_CONTEXT` |
| 2 | `citations_resolve_trusted_fresh` | every citation resolves to a retrievable `DocumentVersion` whose `freshness_state` is `fresh` under `knowledge.freshness_window[source_class]` and whose trust tier is at or above `knowledge.answer_trust_floor` — both named 005 configuration keys, starting values in R-26 | 005 documents, the two 005 keys, freshness state | `INSUFFICIENT_CONTEXT` |
| 3 | `category_allowlisted` | the classified category is in `category_allowlist` for this tenant; unclassified or ambiguous is false | ticket category, allowlist | `NEEDS_HUMAN` |
| 4 | `no_blocked_topic` | no category candidate is in `blocked_topic` | candidates, blocked set | `NEEDS_HUMAN` (already terminated at step 2; the predicate is a belt) |
| 5 | `tenant_verified` | ownership verified at retrieval **and** at finalisation for every cited document | citation verification timestamps | `NEEDS_HUMAN` + incident (FR-015) |
| 6 | `supporting_precedent_exists` | a resolved issue with production verification, or a cited document whose provenance is `human_authored` or `machine_generated_human_adopted` | citations, 005 provenance | `INSUFFICIENT_CONTEXT` |
| 7 | `factual_tokens_bound` | every factual token traces to a `structured_fact_binding`, and `generated_token_scan.clean` is true | bindings, scan | `NEEDS_HUMAN` |
| 8 | `grounding_fully_grounded` | `grounding_verdict.verdict = fully_grounded`, and no claim has `claim_kind = commitment` | grounding verdict, claims | `INSUFFICIENT_CONTEXT` (ungrounded) or `NEEDS_HUMAN` (commitment) |

A `machine_generated` document may be cited (predicate 1, 2) with reduced weight but never satisfies
predicate 6 alone (005 FR-008, R-16).

## Grounding: what the check may and may not do

```text
stage 1  deterministic span matching over the pinned DocumentVersion text
         exact comparison for number, currency, date and identifier claims
         lexical-overlap floor for prose claims
         no candidate span  →  ungrounded. There is no later stage that can rescue it.

stage 2  a model inspects a proposed span and may REJECT it as not supporting the claim.
         The model cannot create a match, widen one, or overrule a rejection.
```

The grounding step receives the claim text and the source text. It does **not** receive the drafting
run's rationale, tool transcript or self-assessment (FR-008, US-3 scenario 3). Its verdict is an
evidence record emitted by the grounding step, not a field the drafting step wrote (US-3 scenario 4).

Cross-language claims have no deterministic candidate span and are therefore ungrounded; grounding
is never performed against a translation of the source (R-18).

## Hold and release

| Condition | Effect |
|---|---|
| Ticket linked to an issue under active investigation | outcome `held`, linked issue named, **no draft produced** (FR-018) |
| Linked pull request merged | **no effect** — merged is not resolved (R-11) |
| `IssueResolved` with `resolutionKind ∈ {remediated, fixed}` and non-empty verification evidence (001 `contracts/events.md`) | ticket released; the draft cites the production verification evidence |
| `IssueResolved` with `resolutionKind = self_resolved`, or either other kind carrying no verification evidence | **escalates**, never releases — there is no evidence for a draft to cite (FR-018, C-09) |
| `held_until` passes | escalates to a human with what was collected (FR-020) |
| `IssueReopened` after answers were drawn from it | every such ticket flagged for human follow-up (FR-019) |

## Budget

Budget exhaustion or the degradation order reaching its floor produces `NEEDS_HUMAN` with what was
collected (FR-025, 002 FR-011, FR-012). The degradation order may reduce retrieval depth or model
tier; **it may never relax a predicate** — a cheaper run still passes all eight or it is not an
`AUTO_REPLY` (R-21).

## Publication

`AUTO_REPLY` publishes the draft-ready event and stops. That publication takes an
`AnswerPublishCapability` argument and can obtain one from nowhere else — not the container, not a
module import, not ambient configuration ([ADR 0008](../../../docs/adr/0008-capability-passing.md),
FR-016, R-28). A support run without the capability cannot reach the publication path, which is what
makes a simulation replaying a ticket safe by construction rather than by a branch (011 R-01).

## What the decision records

Every outcome is written to the audit trail with the predicates evaluated, the failing predicate
where applicable, the rule version, the evidence references, the model identifier and the prompt
version (FR-024, 001 FR-012, 002 FR-017). Every one of those is resolvable later (SC-008).
