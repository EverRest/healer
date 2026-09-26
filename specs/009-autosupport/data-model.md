# Data Model: grounded answers to human-reported issues

Schema `support`. Identifiers are UUID v7; timestamps `timestamptz` UTC. Every table carries
`tenant_id` with an index `(tenant_id, …)` (012 FR-048,
[prisma rules](../../.claude/rules/prisma-migrations.md)).

Referenced, never redefined here: `issue.issue`, `issue.ingestion_delivery`, `evidence.evidence`,
`evidence.evidence_link`, `audit.audit_entry` (001); `prompt_version`, `agent_run`, `workflow_run`,
`workflow_callback` (012); `PolicyRule` and `PolicyDecision` (002); `KnowledgeDocument`,
`DocumentVersion`, `Constraint` and provenance (005); `Component` (004).

This feature owns no retrieval table and no policy-rule table. `AnswerPolicy` is a rule set in 002's
engine; what is stored here is the **result** of evaluating it.

## support.support_ticket

The intake projection of a `user_report` issue. The `Issue` is the aggregate; this is the channel
view of it.

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| issue_id | uuid | 001, `kind = user_report` (FR-001) |
| channel | enum | `webhook` · `email` · `gitlab_issue` (D-21) |
| external_ref | text | provider id, `Message-ID`, or project+iid+note |
| delivery_id | text | idempotency key, recorded in 001's `ingestion_delivery` (FR-002) |
| reporter_ref | text | channel-scoped reference — **never a name, address or account record** (R-22) |
| body_excerpt | text | bounded at capture (001 FR-011); data, never instruction (FR-023) |
| quoted_history_excerpt | text? | bounded; retained as context only (R-03) |
| language | text | BCP-47, detected deterministically; outside the declared scanner set (`en`, `de`) the ticket is `NEEDS_HUMAN` before drafting (FR-012a, R-18) |
| category | text? | classified; null means not allowlisted (FR-011) |
| category_candidates | text[] | any blocked candidate wins (FR-010) |
| received_at | timestamptz | |

Unique `(tenant_id, channel, delivery_id)`. Index `(tenant_id, issue_id)`,
`(tenant_id, category, received_at)`.

## support.ticket_issue_link

`id`, `tenant_id`, `ticket_id`, `linked_issue_id`, `relation` (`waits_on` · `related_to`),
`hold_state` (`held` · `released` · `escalated`), `held_until` timestamptz?,
`release_condition` (`issue_resolved_verified_in_production` — the only value),
`released_at?`, `released_by_event_id?`.

`release_condition` is an enum with one value on purpose: releasing on merge or on deploy should not
be expressible, not merely defaulted away (R-11). `held_until` is the workflow deadline, not a poll
(R-12, 012 FR-025).

A move to `released` requires an `IssueResolved` whose `resolutionKind` is `remediated` or `fixed`
**and** whose verification evidence identifiers are non-empty. `self_resolved` — and either of the
other two arriving with no verification evidence — moves the link to `escalated`, never to `released`
(FR-018, C-09). `released_by_event_id` is therefore always an event of one of those two kinds.

Index `(tenant_id, linked_issue_id, hold_state)`, `(held_until) where hold_state = 'held'`.

## support.answer_draft

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| ticket_id | uuid | |
| text_template | text | generated text **with unresolved `{{fact:…}}` slots** (R-08) |
| text_rendered | text? | after binding; null while any slot is unbound |
| language | text | reporter's language |
| drafting_agent_run_id | uuid | 012 — model, prompt version, cost |
| decomposer_agent_run_id | uuid? | a **different** run (R-06) |
| outcome | enum | `AUTO_REPLY` · `NEEDS_HUMAN` · `INSUFFICIENT_CONTEXT` (FR-004) |
| outcome_rationale | jsonb | structured; the predicate results, not prose |
| invalidated_at | timestamptz? | pinned citation version changed (R-17) |
| created_at | timestamptz | |

Index `(tenant_id, ticket_id, created_at)`.

The outcome enum has **no hedged value**. There is no `AUTO_REPLY_WITH_CAVEAT` (US-2 scenario 4).

A draft exists for non-allowlisted categories too, attached to a `NEEDS_HUMAN` outcome — it is the
input to the C-07 measurement (R-15). A draft does **not** exist for a blocked category: those
terminate before drafting (SC-007, R-04).

## support.draft_claim

`id`, `tenant_id`, `draft_id`, `seq`, `claim_text`, `claim_kind`
(`factual_token` · `prose_assertion` · `procedural_step` · `commitment`), `grounded` bool,
`ungrounded_reason` (`no_candidate_span` · `span_rejected` · `cited_document_silent` ·
`cross_language` · `source_version_changed`), `created_at`.

Produced by the decomposer run from the draft text alone (R-06). `claim_kind = commitment` rejects
the draft outright (FR-013, R-09).

## support.citation

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| draft_id | uuid | |
| claim_id | uuid? | **written by the deterministic retrieval binding step, never by an agent** (R-27); null for a document cited without a claim — permitted, but it satisfies nothing |
| source_kind | enum | `knowledge_document` · `resolved_issue` · `evidence_record` |
| document_id, document_version | uuid, int | pinned (005 FR-019) |
| provenance | enum | `human_authored` · `machine_generated` · `machine_generated_human_adopted` (005 FR-007) |
| trust_weight | numeric | from 005's ranking; `machine_generated` reduced (005 FR-008) |
| freshness_state | enum | `fresh` · `stale` · `unknown` — captured at time of use |
| tenant_verified_at_retrieval | timestamptz | |
| tenant_verified_at_finalisation | timestamptz? | mismatch aborts and raises an incident (FR-015) |

A `machine_generated` citation never alone satisfies the supporting-precedent predicate (R-16).

`claim_id` decides which document grounding searches for that claim, so no agent output schema in
this feature has a field that maps to it: the binder computes the candidates deterministically from
the retrieval result set (R-27). A model choosing the document per claim would be choosing the
document most likely to contain a matching span, which is R-06's omission problem one level down.

## support.structured_fact_binding

`id`, `tenant_id`, `draft_id`, `slot_key` (e.g. `invoice.amount`), `field_name`, `source_system`,
`source_ref`, `value` text, `value_type` (`number` · `date` · `currency` · `duration` ·
`identifier` · `sla`), `read_at`, `bound` bool.

Unique `(draft_id, slot_key)`. Every factual token in `text_rendered` traces to a row here
(FR-012, SC-002). An unbound slot removes its sentence and degrades the outcome (R-08).

## support.generated_token_scan

`id`, `tenant_id`, `draft_id`, `findings` jsonb (offset, token, shape), `clean` bool, `scanned_at`.

The deterministic scan of generated text for unbound numerals, dates, amounts, durations,
identifiers and SLA shapes. `clean = false` rejects the draft (R-08). Retained because "why was this
draft rejected" must be answerable a month later.

## support.grounding_verdict

`id`, `tenant_id`, `draft_id`, `verdict` (`fully_grounded` · `ungrounded`), `claims_total`,
`claims_grounded`, `matcher_version`, `overlap_floor`, `model_rejections` int,
`grounding_agent_run_id?`, `decided_at`.

**Written by the grounding step, never by the drafting step**, and recorded as an evidence record
emitted by that step (FR-008, 001 FR-008, US-3 scenario 4). `model_rejections` counts spans a model
removed; the model cannot add a match, so there is no `model_additions` column (R-07).

## support.answer_predicate_result

`id`, `tenant_id`, `draft_id`, `policy_decision_id` (002), `rule_version`, `predicate`
(`claims_have_citations` · `citations_resolve_trusted_fresh` · `category_allowlisted` ·
`no_blocked_topic` · `tenant_verified` · `supporting_precedent_exists` ·
`factual_tokens_bound` · `grounding_fully_grounded`), `result` bool, `detail` jsonb, `evaluated_at`.

Every predicate is recorded, not only the failing one (US-2 scenario 5). **No row exists for a
confidence predicate, and no `detail` field is read by a rule** (FR-005, FR-007, 002 FR-003).

Unique `(draft_id, predicate)`.

## support.answer_feedback

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| draft_id | uuid | |
| signal | enum | `sent_unedited` · `sent_cosmetic_edit` · `sent_material_edit` · `reopened` · `human_verdict` |
| sent_text_digest | text? | digest, not the text |
| diff_summary | jsonb? | which bound tokens or claim-bearing clauses changed (R-14) |
| reopened_within | interval? | |
| reported_by | text | the external actor that sent — never Healer (FR-017) |
| model_id, prompt_version_id | text, uuid | from the draft's `agent_run` (012 FR-033) |
| evidence_ids | uuid[] | the draft's evidence set |
| occurred_at | timestamptz | |

Index `(tenant_id, prompt_version_id)`, `(tenant_id, model_id)`, and via `draft → ticket` by
category — the four axes 011 queries on (FR-022, SC-010).

## support.category_eligibility

The C-07 measurement.

| Field | Type | Rules |
|-------|------|-------|
| tenant_id, category | uuid, text | PK together |
| drafts_produced | bigint | includes non-allowlisted categories (R-15) |
| sends_reported | bigint | |
| consecutive_clean_sends | int | unedited **and** not reopened inside the window |
| threshold | int | default **10**, a product constant; check constraint `threshold >= 10` and a clamp on the write path, so a tenant may raise it and never lower it (FR-011b, R-23) |
| last_reset_reason | enum? | `material_edit` · `reopen` |
| last_reset_at | timestamptz? | |
| promotable | bool | derived: `consecutive_clean_sends >= threshold` |
| updated_at | timestamptz | |

Any `sent_material_edit` or `reopened` resets `consecutive_clean_sends` to zero — consecutive, not
cumulative, so a long good history cannot hide a recent regression (R-15). A `human_verdict` row
touches neither `consecutive_clean_sends` nor `sends_reported`: it is a quality signal for 011 only
(FR-021a, R-24).

`threshold` is written only through the eligibility administration endpoint, which clamps to the
floor; the constraint makes a lower row impossible and the clamp makes a lower write ineffective,
which is how 002's `ACTION_CEILING` is enforced and for the same reason — one mechanism away from
silent failure is not enough for a value the party who wants the category promoted would like lower.

## support.category_allowlist

`tenant_id`, `category` (PK together), `promoted_by` (human actor ref), `promoted_at`,
`eligibility_snapshot` jsonb, `revoked_at?`.

Starts **empty** for every tenant (C-07). A write is refused when the category is in the blocked set
(FR-010, 002 FR-008). The system never inserts a row here; only a recorded human action does
(R-15).

## support.blocked_topic (product-level, not tenant-scoped)

`category` (PK), `set_version` int, `added_at`, `note`.

Covers money, billing, refunds, account mutation, authentication and access, legal, compliance,
security and personal data (FR-010). This is the one table in the feature without `tenant_id`,
because it is not a tenant's to configure — and it is not reducible by any tenant-facing write path.

## State transitions

```text
ticket:   received ──classified──▶ categorised
          categorised ──blocked category──▶ NEEDS_HUMAN (no draft exists)
          categorised ──linked to open issue──▶ held
          held ──IssueResolved(remediated | fixed, evidence non-empty)──▶ releasable
          held ──IssueResolved(self_resolved), or either kind with no evidence──▶ escalated (C-09)
          held ──held_until passes──▶ escalated (human)
          categorised | releasable ──retrieval + draft──▶ drafted
          drafted ──grounding + binding + policy──▶ AUTO_REPLY | NEEDS_HUMAN | INSUFFICIENT_CONTEXT
          AUTO_REPLY ──outbox──▶ draft published; Healer stops here
                       (publication takes AnswerPublishCapability — ADR 0008, FR-016, R-28)

draft:    assembled ──slots bound──▶ rendered ──grounded──▶ decided
          decided ──cited version changed──▶ invalidated ──▶ re-evaluated (never released stale)

category: not_allowlisted ──consecutive clean sends ≥ threshold──▶ promotable
          promotable ──human tenant decision──▶ allowlisted
          allowlisted ──revoked by tenant──▶ not_allowlisted
```

## Invariants

- No `answer_draft` with `outcome = AUTO_REPLY` has a `draft_claim` with `grounded = false`
  (SC-001, continuous check).
- No `answer_draft` with `outcome = AUTO_REPLY` has `text_rendered` null. A null `text_rendered` means
  a slot is still unbound (R-08), and an `AUTO_REPLY` whose text does not exist would publish an event
  whose payload cannot be assembled (FR-012, FR-016).
- No `answer_draft` exists for a ticket whose `language` is outside the declared scanner set; the
  refusal precedes drafting (FR-012a, R-18).
- No `citation.claim_id` is written by a step other than the deterministic retrieval binder, asserted
  by the absence of any mapping from an agent output field to it (R-27).
- `category_eligibility.threshold` is never below 10, by check constraint (FR-011b, R-23).
- No `answer_feedback` row with `signal = human_verdict` changes `consecutive_clean_sends` or
  `sends_reported` (FR-021a, R-24).
- Every factual token in a rendered `AUTO_REPLY` draft resolves to a `structured_fact_binding` with
  a source and a read timestamp, and its `generated_token_scan.clean` is true (SC-002).
- Every `answer_draft` has exactly eight `answer_predicate_result` rows for the rule version used,
  and `AUTO_REPLY` requires all eight true (FR-006, SC-008).
- `grounding_verdict.grounding_agent_run_id`, where present, is a different `agent_run` from
  `answer_draft.drafting_agent_run_id` (FR-008).
- No `citation` in an `AUTO_REPLY` draft has `tenant_verified_at_finalisation` null or a tenant other
  than the ticket's (FR-015, SC-004).
- No `ticket_issue_link` moves to `released` except by an `IssueResolved` event carrying production
  verification (SC-006, R-11).
- No row exists in `category_allowlist` for a category present in `blocked_topic` (FR-010).
- No `answer_draft` exists for a ticket whose category is blocked — measured as absence of a
  `drafting_agent_run_id` cost on those tickets (SC-007).
- Every `answer_feedback` row carries a non-null `model_id` and `prompt_version_id` (SC-010).
- Every read is constrained by `tenant_id` from the authenticated context; a foreign identifier
  returns not-found (001 FR-015, 012 FR-013).
