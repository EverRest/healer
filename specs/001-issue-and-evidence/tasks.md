# Tasks: Issue lifecycle and evidence substrate

**Input**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/openapi.yaml](contracts/openapi.yaml),
[contracts/events.md](contracts/events.md), [quickstart.md](quickstart.md)

**Prerequisites**: [012](../012-engineering-foundation/tasks.md) phases 1–2 — workflow machine,
outbox, tenancy context, gate harness.

**Tests**: TDD is constitutional. Every immutability and isolation guarantee gets a test that is
seen to fail first; a guarantee nobody has watched fail is an assumption.

**Organization**: one phase per user story. US1–US3 are P1 and block 003 and 006.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [X] T001 Packages `packages/domain/issues` and `packages/domain/evidence` with their entry surfaces (012 FR-001) — entry surfaces already existed from 012 phase 1 scaffolding
- [X] T002 [P] Prisma models for schemas `issue`, `evidence`, `audit` per [data-model.md](data-model.md) — including `issue_relationship`; first migration — fixed a stray `'closed'` state reference in data-model.md (no such state exists; corrected to `state not in ('merged', 'removed')`, see QUESTIONS.md) and two missing tenant-leading indexes (`evidence_link`, `deletion_tombstone`) the migration e2e suite caught on first run
- [X] T003 [P] Database rules rejecting `UPDATE` and `DELETE` on `evidence`, `evidence_link`, `issue_event`, `audit_entry` (R-03) — trigger-based, with a `healer.privileged_write` session-GUC bypass for the retention/tenant-deletion paths (T052/T053, not yet built)

---

## Phase 2: Foundational (blocks US1–US5)

- [X] T004 **Test first**: attempt to update an evidence row through Prisma and through raw SQL; both rejected at the database, not by the repository (R-03, quickstart 8) — `append-only.e2e.test.ts`: rejects tampering, allows the one legitimate `ref_state` transition, rejects the reverse, rejects DELETE, allows the privileged bypass, confirms `issue_event`/`audit_entry` fully immutable; through raw SQL (not yet Prisma — no repository exists until T006/T012)
- [X] T005 `domain/evidence`: `Evidence` and `EvidenceLink` types; excerpt bounding at capture with `excerptTruncated` (R-05, FR-011) — `excerpt`/`excerptTruncated` modeled as a discriminated union (same technique as 012's `WorkflowState`) so "truncated but nothing captured" is unrepresentable; `boundExcerpt` slices by Unicode code point, not UTF-16 code unit, so a multi-byte character at the cut boundary is dropped whole rather than split into a lone surrogate. Found and fixed a real gap in `gate-coverage-completeness` (0.18.0): a pure type-only file or barrel re-export produces zero v8-instrumentable statements and was being flagged as "untested" regardless of any test — broadened the gate's exemption from content-based detection of the `export {}` stub alone to detecting the presence of any real runtime-declaration keyword.
- [X] T006 Append-only evidence repository: write and read only; `ref_state` may move `linked → detached` and nothing else (FR-010) — `PrismaEvidenceRepository` (`packages/domain/evidence/src/infrastructure/`), the first real `@prisma/client` consumer in the repo. New `@healer/prisma-client` workspace package (ADR 0013) so every future repository depends on one stable name instead of a `link:` path to a build artifact. Tenant scoping through the composite `(id, tenantId)` key in the query itself, not a post-fetch check; `detach` translates Prisma's "not found" into `NotFoundError`, never leaking whether another tenant's row exists. Verified against a live Postgres (`evidence-repository.e2e.test.ts`, repo root — same rootDir constraint that moved T004's test there): record/read, tenant isolation on read, the composite FK rejecting a cross-tenant write, and the `linked → detached` transition, 6/6. Found and fixed two more real bugs surfaced only by actually running the gates: `deps-check`'s ADR-diff check was requiring an ADR for a brand-new *internal* `@healer/*` dependency edge, which isn't what FR-006 governs; and a genuine vitest/v8-coverage bug where a workspace package resolved differently for a same-package import (live source) than a cross-package import (built `dist/`), producing duplicate, non-summing coverage entries for shared modules like `@healer/shared`'s tenancy code — fixed by aliasing every workspace package name to its own `src/index.ts` in `vitest.config.ts`. `infrastructure/**` is now excluded from the unit coverage floor (documented in QUESTIONS.md): its real guarantee is `make test-e2e` passing against a live database, not a unit-coverage percentage.
- [ ] T007 **Test first**: writing an `evidence_link` attributed to a step other than the executing one is rejected with `STEP_ATTRIBUTION_MISMATCH` (R-06, quickstart 10)
- [ ] T008 Producer attribution enforcement: the link writer takes the executing step from the call context, not from its arguments (FR-008)
- [ ] T009 **Test first**: persisting a conclusion with no link fails with `EVIDENCE_REQUIRED` (FR-009, quickstart 9)
- [ ] T010 Conclusion reference constraint: every conclusion table declares a non-nullable link requirement, checkable by `gate-evidence` (012 T031)
- [ ] T011 `normalisation_ruleset` as versioned data; a fingerprint records the version that produced it (R-01, FR-003)
- [ ] T012 `domain/issues`: `Issue`, persisted state machine over the transitions in [data-model.md](data-model.md), every transition recorded with its cause, built on 012's workflow machine (FR-006)
- [ ] T013 [P] Outbox publishers for the events in [contracts/events.md](contracts/events.md) (FR-014, 012 T012)
- [ ] T014 [P] Tenant scoping on every repository method; a query without `TenantContext` fails to type-check (FR-015, 012 T010)

---

## Phase 3: US1 — One issue, not a thousand errors (P1)

**Independent test**: quickstart 1, 2, 3, 4, 5, 6, 7

- [ ] T015 **Test first**: replay 12 000 recorded errors from two providers → one issue, `occurrenceCount = 12000`, correct first and last seen (SC-001, quickstart 1)
- [ ] T016 **Test first**: same failure with differing identifiers, addresses and generated-file line offsets → identical fingerprint; different exception types → separate issues (quickstart 2, 3)
- [ ] T017 Normalisation implementing T016 against `normalisation_ruleset` (FR-003)
- [ ] T018 Fingerprint computation and attachment of matching signals to the open issue (FR-002)
- [ ] T019 `POST /ingest/signals`: batch ≤ 1000, always `202`, never blocks the provider (FR-019)
- [ ] T020 **Test first**: the same batch posted twice with one `X-Delivery-Id` → `duplicate: true`, counts unchanged (FR-004, quickstart 4)
- [ ] T021 `ingestion_delivery` idempotency implementing T020 (R-09)
- [ ] T022 Reopen and recurrence: inside the window reopen; outside it a new issue linked by a `recurrence_of` row in `issue_relationship` (FR-005, FR-020, R-02, quickstart 5, 6)
- [ ] T023 [P] `observed_at` and `received_at` on every signal; ordering by observed, retention by received (R-10, quickstart 7)
- [ ] T024 [P] Malformed payloads: create the issue from what parsed and record the parse failure as evidence; nothing dropped silently (FR-019, quickstart 20)
- [ ] T025 [P] Downstream failure retains the signal for retry; repeated failure is observable (R-09, quickstart 21)
- [ ] T026 Load check: sustain the design signal rate with issue visibility inside the plan's latency budget (SC-006)

---

## Phase 4: US2 — Every claim carries its evidence (P1)

**Independent test**: quickstart 8, 9, 10, 11, 12, 13

- [ ] T027 `RecordEvidence` for every shape in the closed set, validated against 012's boundary schemas (FR-007, FR-007a, 012 T040)
- [ ] T028 `AttachLink` with relation `supports` · `contradicts` · `contextualises`; unique per (evidence, conclusion, relation)
- [ ] T029 **Test first**: delete the source log range, re-read the issue → evidence shows `detached` with its label, conclusions intact (R-04, quickstart 12)
- [ ] T030 Detachment on source loss, preserving excerpt and `source_label` (FR-010)
- [ ] T031 [P] `GET /issues/{id}/evidence` with type filter
- [ ] T032 [P] **Test**: a 40 MB payload stores a bounded extract plus a reference, marked truncated (R-05, quickstart 13)
- [ ] T033 [P] Continuous invariant check `check:evidence-coverage` — every conclusion has ≥ 1 resolvable link (SC-002)
- [ ] T034 [P] Continuous invariant check `check:append-only` — zero updates recorded on immutable tables (SC-003)
- [ ] T035 [P] Continuous check `check:expired-evidence` — nothing past `expires_at` is still linked
- [ ] T036 Contract review assertion: **no API exists** to create a link retrospectively or for another step (quickstart 11)

---

## Phase 5: US3 — One pipeline for every source (P1)

**Independent test**: quickstart 22, 25, 26

- [ ] T037 Issue kinds including `knowledge_drift`; all kinds enter the same pipeline up to the decision point (FR-001)
- [ ] T038 **Test first**: a `knowledge_drift` issue reaches human adjudication and **cannot** enter reproduction or change (FR-001a, quickstart 25)
- [ ] T039 `issue_relationship` and deterministic correlation: a user report and an alert sharing component, environment and window are linked `related` by a **named rule** recorded on the row, never merged, and neither issue's state changes; publishes `IssueRelated` (FR-020, quickstart 26)
- [ ] T040 [P] `GET /issues` and `GET /issues/{id}`
- [ ] T041 e2e isolation matrix: issue, evidence, timeline and audit endpoints all return 404 for another tenant — never 403 (SC-004, quickstart 22)

---

## Phase 6: US4 — The audit trail answers "why did you do that" (P2)

**Independent test**: quickstart 16

- [ ] T042 `audit_entry` for every agent action and every policy decision, written in the same transaction as the action it describes (FR-012)
- [ ] T043 **Test**: every agent-action entry resolves to a retrievable prompt version and model identifier (SC-007, 012 T064)
- [ ] T044 [P] `GET /issues/{id}/audit`

---

## Phase 7: US5 — Views over one dataset (P2)

**Independent test**: quickstart 14, 15, 16

- [ ] T045 **Test first**: render the timeline twice → byte-identical output (SC-005, quickstart 14)
- [ ] T046 `GetTimeline` as SQL **union** over `issue_event` (domain facts), 012's `workflow_transition` (machine steps) and `evidence`, ordered by `observed_at`; the two event tables are different grains and neither is total, and nothing is copied between them; **no model call anywhere in the path** (FR-013, R-07, C-14, quickstart 15)
- [ ] T047 [P] `GetEvidenceGraph` over the same records as nodes and edges
- [ ] T048 [P] **Test**: timeline, evidence graph and audit for one issue contain the same facts (quickstart 16)

---

## Phase 8: Polish and data lifecycle

- [ ] T049 Merge: write a `merged_into` relationship row and a merge event; **evidence is not copied** (FR-016, FR-020, quickstart 17)
- [ ] T050 Unmerge by setting `removed_at` on the relationship, restoring independence; counts restored to both sides, not split (R-08, quickstart 18)
- [ ] T051 [P] Staleness job marking and surfacing; **never auto-resolving** (FR-017, R-11, quickstart 19)
- [ ] T052 [P] Retention job purging expired evidence and detaching what outlives its source
- [ ] T053 Tenant deletion: remove issue, evidence and audit content; leave a tombstone with no content (FR-018, R-12, quickstart 23)
- [ ] T054 [P] **Test**: `IssueResolved` is emitted only by production verification (`remediated`, `fixed`) or a human close (`self_resolved`) — never by merge and never by deploy; `self_resolved` carries **no** verification evidence (quickstart 24, [contracts/events.md](contracts/events.md))
- [ ] T055 [P] Regenerate `contracts/openapi.json` and check for drift (012 T033)
- [ ] T056 Run the whole of [quickstart.md](quickstart.md) — all 27 scenarios including the negative ones
- [ ] T057 `POST /issues/{id}/close`: a human close resolves the issue with `resolutionKind = self_resolved` and no verification evidence, recorded as an `issue_event` with cause `human` (FR-021, C-09, quickstart 27)

---

## Dependencies

```text
012 phases 1–2 ──▶ Phase 1 ──▶ Phase 2 ──┬─▶ Phase 3 · US1 (T015–T026)
                                          ├─▶ Phase 4 · US2 (T027–T036)
                                          ├─▶ Phase 5 · US3 (T037–T041) ← needs T012
                                          ├─▶ Phase 6 · US4 (T042–T044)
                                          └─▶ Phase 7 · US5 (T045–T048) ← needs T013 and any of 3–4
Phase 8 (T049–T057) last
```

**Explicit dependencies beyond phase order**

- T010 and 012's `gate-evidence` are the same guarantee from two directions; land T010 first so the
  gate has something to pass on.
- T041 is what makes 012's `gate-isolation` enableable — it is the first route with an isolation test.
- T027 depends on 012's closed boundary schema set existing.

## Parallel groups

- Foundational: T013, T014 after T012.
- US2: T031–T035 together — separate files, separate checks.
- US5: T047, T048 after T046.
- Polish: T051, T052, T054, T055.

## Strategy

1. **Phase 2 before any story.** The three guarantees — append-only, producer attribution, no
   conclusion without evidence — are what everything downstream assumes. Building a story first and
   adding them later means retrofitting the property the product is sold on.
2. **US1 next**, because deduplication is what makes the system usable at the first real incident and
   because every downstream cost multiplies by the duplication factor until it works.
3. US2 with US1: evidence recording is the other half of ingestion, and the invariant checks
   (T033–T035) should start running while the data volume is still small enough to fix cheaply.
4. US3 after US1–US2 — it needs issues and evidence to correlate.
5. US4–US5 are read surfaces over data that already exists; they can wait without blocking 003 or 006.
6. Phase 8 before the pilot: merge, retention and deletion are the operations that are painful to
   retrofit once real data exists.
