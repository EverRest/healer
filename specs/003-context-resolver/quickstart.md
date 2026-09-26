# Quickstart: context resolution across the hybrid boundary

```bash
make bootstrap
make test -- --testPathPattern domain/context
make test-e2e -- --testPathPattern 003-
make runner-contract-test      # the boundary schema is closed (012 FR-022)
make context-marker-corpus     # seeded PII and secret markers; inspects every crossed byte (SC-001)
make context-injection-diff    # differential run with and without injected instructions (SC-010)
```

## Scenarios

Scenarios 3, 4, 5, 6, 7, 8, 12, 13, 17, 22, 26, 29, 31 and 33 must **fail, withhold or quarantine**
— a boundary nobody has watched refuse something is a boundary nobody knows is there.

| # | Scenario | Steps | Expectation |
|---|----------|-------|-------------|
| 1 | One snapshot, all sources | issue against a seeded environment with eight sources | exactly one finalised `ContextSnapshot` **version** for the issue, items from all eight; a re-collection adds version n+1 (Story 2, FR-022) |
| 2 | Parallel, not sequential | one source artificially slow | wall clock within 2× the slowest source, flat in source count (FR-003, SC-006) |
| 3 | Nothing raw crosses | seed logs, traces and config with known PII markers and secrets, inspect every crossed byte | 0 markers present (FR-007, SC-001) |
| 4 | Config values never cross | collect configuration and feature flags | key names, value types and change indicators only — no values (FR-007) |
| 5 | Source code does not cross in bulk | run a full collection over a repository | file paths and symbols only; no file content (FR-011) |
| 6 | Named file retrieval is the exception | request the `source_file` collector for one named file | crosses as its own audited pass under the follow-up cap (FR-011, R-12) |
| 7 | Unredactable is withheld | a log format the redaction ruleset does not recognise | item withheld, `collection_gap` with `redaction_withheld`, **not** truncated (FR-009, 012 R-05) |
| 8 | The withheld reference is ours to hold, not to follow | take the `localRef` from a withheld gap and try to resolve it from the control plane | no path exists; a human inside the customer's plane resolves it with `make runner-resolve-ref` (R-08) |
| 9 | Redaction-dominated is kept, not withheld | an excerpt that survives redaction carrying no signal | item crosses with structured derivatives and `redactionDominated: true` |
| 10 | Every item is evidence | inspect any snapshot item | resolves to an `Evidence` record with source system, reference and observed time (FR-012, SC-008) |
| 11 | Producer attribution | inspect the evidence links the collection step wrote | `produced_by_step` is the collection step (001 FR-008) |
| 12 | One source down | disable the metrics backend | snapshot from the remaining seven; metrics recorded `unavailable` with a reason (FR-015, SC-005) |
| 13 | Every source down | disable all eight | an empty snapshot is still produced, all sources recorded (FR-015, SC-004) |
| 14 | Degradation is citable | read the gaps of a degraded snapshot | one `collection_gap` evidence record per non-collected source (R-07) |
| 15 | The honest unknown persists | make 006 conclude `INSUFFICIENT_CONTEXT` citing a gap | the conclusion persists with its evidence link (006 FR-013, 001 FR-009) |
| 16 | Timeout keeps partial | a source exceeds its timeout mid-answer | what it returned is kept, marked `partial` and truncated; collection does not block (FR-016) |
| 17 | Auth revoked is not empty | revoke a collector's credentials mid-collection | `unavailable` with `auth_revoked` — distinguishable from `empty_result` |
| 18 | Retention is a correct answer | collect for an issue older than a source's retention | `unavailable` with `retention_exceeded`, not a defect |
| 19 | Deterministic plan | generate the plan for the same issue 100 times | one distinct plan, one `planDigest`, resolvable ruleset version (FR-004, SC-007) |
| 20 | No model in the plan path | inspect the plan-generation code path | no model call exists (FR-004) |
| 21 | Requested versus resolved | connect a runner missing one read collector | requested plan unchanged; collector `not_attempted` with `capability_unavailable`; resolution recorded (R-04, 012 R-03) |
| 22 | Follow-up cap | request follow-up passes past the configured limit | `409 FOLLOW_UP_CAP_REACHED` (FR-005) |
| 23 | Follow-up is attributed | request one targeted pass | its own `collection_pass` row with requester and reason (FR-005) |
| 24 | Undeclared collector | ask for a collector key that is not in the registry | `422 UNDECLARED_COLLECTOR`; the field is an enum, so it does not typecheck in-process either (R-12) |
| 25 | Injection changes nothing | inject `ignore all previous instructions…` into every source, rerun | identical plan digest, item ordering, policy decisions and tool calls (FR-021, SC-010) |
| 26 | Content cannot reach a predicate | try to pass a collected excerpt into `DecisionInput` | does not compile — the branded type has no accepting parameter (002 R-03, R-11) |
| 27 | Injected text is still visible | read the item carrying it | present as untrusted data with source attribution intact; the attempt is not erased (Story 5) |
| 28 | Dedup with counts | collect 12 000 lines sharing a signature | one item, occurrence count preserved, first/last observed correct (FR-018) |
| 29 | One normaliser | compare the context dedup signature with the issue fingerprint | same `normalisation_ruleset` version; no second normaliser exists (R-10) |
| 30 | Ranking is explainable | inspect any ranked item | score plus the named terms and their contributions (FR-019) |
| 31 | Ordering is stable | rank the same snapshot twice, including a score tie | byte-identical ordering; the tie resolves by the declared total order (SC-007, R-09) |
| 32 | The cut retains | exceed the context budget | items below the cut kept with `inclusionState = excluded`, cut score recorded (FR-020) |
| 33 | Non-conforming payload | post a batch with a free-form string field | `422 BOUNDARY_SCHEMA_REJECTED`, quarantined, nothing stored (FR-010, SC-002) |
| 34 | Rejection stores no payload | inspect the `boundary_rejection` row | error paths, digest and size only — no content (R-13) |
| 35 | Rejections are visible | read `/boundary-rejections` as the tenant | the rejection appears (FR-010) |
| 36 | Runner offline | create an issue with no runner registered | pass held as `runner_unavailable`; context shows pending, not empty; no job waits (FR-025) |
| 37 | Deadline with no batch | dispatch a pass, never deliver a result | deadline tick finalises the snapshot with every source `not_attempted` (012 FR-029) |
| 38 | Idempotent collection | deliver the same result batch twice | second returns `duplicate: true`; no duplicate evidence records (FR-026, R-05) |
| 39 | Immutable snapshot | attempt to add an item to a finalised snapshot | rejected; re-collection creates version n+1 with the predecessor readable (FR-022) |
| 40 | Clock skew | runner and source clocks five minutes apart | window selection uses observed time; collection timestamp is the runner's (FR-001) |
| 41 | Contradiction retained | deploy tool reports v2 live, runtime reports v1 | both items retained; the pair appears in `completeness.contradictions`; neither is dropped (R-14) |
| 42 | Unknown component | collect for an issue with no resolved component | default scope used; `degradedPrecision: true` recorded rather than assumed away |
| 43 | Oversized payload | a 40 MB heap dump | bounded redacted excerpt plus a plane-local reference; the full payload never crosses (FR-013, 001 FR-011) |
| 44 | Budget exhausted mid-run | exhaust the per-issue budget during collection | snapshot finalised `budget_limited`; uncollected sources `not_attempted` with `budget_exhausted` (FR-024, R-15) |
| 45 | Degradation narrows the next pass | cross the soft threshold | the declared order narrows the *next* plan; the in-flight pass is not rewritten (002 FR-012) |
| 46 | No control-plane credentials | search configuration for a customer observability, repository or deployment credential | none exists (FR-002) |
| 47 | Audit per pass | read the audit entry for a pass | plan, ruleset versions, per-source outcomes, transmitted and withheld counts, contract version (FR-027) |
| 48 | Tenant isolation | read another tenant's snapshot, items, passes, rejections and source references | 404 on every one — never 403 (FR-023, SC-009) |

## Invariant checks (run continuously, not only in tests)

```bash
npm run check:gap-coverage         # every non-collected source has exactly one gap record (R-07)
npm run check:plan-determinism     # stored plan digests recompute from their ruleset version
npm run check:ordering-stability    # item order recomputes identically from score and tiebreak
npm run check:boundary-conformance  # every stored item validates against its contract version
npm run check:no-payload-at-rest    # no boundary_rejection row carries payload content (R-13)
npm run check:stuck-passes          # no dispatched pass without a pending callback or a deadline
```
