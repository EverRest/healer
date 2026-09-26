# Quickstart: issue lifecycle and evidence substrate

```bash
make bootstrap
make test -- --testPathPattern domain/issues
make test-e2e -- --testPathPattern 001-
```

## Scenarios

| # | Scenario | Steps | Expectation |
|---|----------|-------|-------------|
| 1 | Burst collapses | replay 12 000 errors sharing a signature from two providers | one issue, `occurrenceCount = 12000`, correct first/last seen (SC-001) |
| 2 | Volatile parts ignored | same failure with different identifiers, addresses and line offsets | same fingerprint |
| 3 | Genuinely different failures | same component, different exception types | separate issues |
| 4 | Delivery retry | POST the same batch twice with one `X-Delivery-Id` | second returns `duplicate: true`; counts unchanged (R-09) |
| 5 | Reopen | resolve, then a matching signal inside the window | same issue reopens |
| 6 | Recurrence | resolve, then a matching signal outside the window | new issue linked `recurrence_of` (R-02) |
| 7 | Clock skew | provider timestamps five minutes ahead | timeline ordered by observed; retention by received (R-10) |
| 8 | Evidence is immutable | attempt to update an evidence row | rejected at the database, not only by the repository (R-03) |
| 9 | Conclusion without evidence | persist a diagnosis with no link | rejected with `EVIDENCE_REQUIRED` (SC-002) |
| 10 | Producer attribution | write a link attributed to another step | rejected with `STEP_ATTRIBUTION_MISMATCH` (R-06) |
| 11 | No retrospective links | look for an API creating links for a past step | none exists — this is a design assertion, tested by contract review |
| 12 | Detachment | delete the source log range, re-read the issue | evidence shows `detached` with its label; conclusions intact (R-04) |
| 13 | Oversized excerpt | ingest a 40 MB stack dump | bounded extract stored, `excerptTruncated = true`, reference kept (R-05) |
| 14 | Timeline determinism | render twice | byte-identical (SC-005) |
| 15 | Timeline has no model | inspect the query path | pure SQL — a union over `issue_event`, 012's `workflow_transition` and `evidence`; no model call (R-07, C-14) |
| 16 | Views agree | compare timeline, evidence graph and audit for one issue | same facts, different arrangements (SC-005) |
| 17 | Merge | merge two issues | both evidence sets remain attached to their originals; merge event recorded |
| 18 | Unmerge | reverse it | both issues independent again; counts restored, not split (R-08) |
| 19 | Stale | leave an issue untouched past the window | marked stale and surfaced; **not** resolved (R-11) |
| 20 | Malformed payload | send a partially unparseable batch | issue created from what parsed; parse failure recorded as evidence; nothing dropped silently |
| 21 | Downstream failure | make the outbox consumer fail | signals retained and retried; repeated failure observable (R-09) |
| 22 | Tenant isolation | read another tenant's issue, evidence, timeline and audit | 404 on every one — never 403 (SC-004) |
| 23 | Deletion | tenant deletes an issue | issue, evidence and audit content gone; tombstone remains with no content (R-12) |
| 24 | Resolved means verified | inspect what emits `IssueResolved` | production verification (`remediated`, `fixed`) or a human close (`self_resolved`) — never merge, never deploy |
| 25 | Knowledge drift terminates | raise a `knowledge_drift` issue | reaches human adjudication; never enters reproduction or change (FR-001a) |
| 26 | Correlation, not merge | ingest a user report and an alert sharing component, environment and window | one `related` relationship naming the rule that produced it; both issues keep their own state and evidence (FR-020) |
| 27 | Human close | close an issue through the API | state `resolved`, `IssueResolved(self_resolved)` with **no** verification evidence; a held 009 ticket escalates rather than being released (FR-021, C-09) |

## Invariant checks (run continuously, not only in tests)

```bash
npm run check:evidence-coverage    # every conclusion has ≥1 link (SC-002)
npm run check:append-only          # no updates on immutable tables (SC-003)
npm run check:expired-evidence     # nothing past expires_at still linked
```
