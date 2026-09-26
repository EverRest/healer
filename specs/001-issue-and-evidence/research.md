# Phase 0 Research: issue lifecycle and evidence substrate

## R-01 · Fingerprint normalisation, and why it is versioned data

**Decision**: the fingerprint is a hash over component, environment, normalised exception type,
normalised top frames, endpoint template and error code. Normalisation strips identifiers, memory
addresses, timestamps, line offsets in generated files and variable URL segments. The rule set is a
versioned row, and every issue records which version produced its fingerprint.

**Rationale**: fingerprint rules will change — the first month of real traffic guarantees it. If
rules are code, every past fingerprint becomes unexplainable after the change, and issues silently
stop matching their own history. As versioned data, a fingerprint can be explained and recomputed.

**Alternatives**: hashing the raw message (one issue per unique identifier — useless); provider-
supplied grouping (each provider groups differently, so two sources of the same failure would never
merge).

## R-02 · Reopen versus recurrence

**Decision**: a matching signal inside the reopen window reopens the issue; outside it, a new issue
is created and linked as `recurrence_of`. The window is per-tenant configuration.

**Rationale**: reopening forever produces an issue that has been "open" for eight months and means
nothing. Always creating new issues loses the pattern — and the pattern is often the diagnosis:
the same failure four times in six weeks is a different problem from one failure once.

## R-03 · Append-only enforced by the database

**Decision**: `evidence`, `evidence_link`, `issue_event` and `audit_entry` reject `UPDATE` and
`DELETE` through database rules. Deletion for retention or tenant request happens through a
privileged path that is itself audited.

**Rationale**: this is a non-negotiable principle, and application-level discipline decays. A
repository that merely does not expose an update method is one convenience method away from being
wrong, and the wrongness is invisible until someone asks why the record changed.

**Alternatives**: event sourcing throughout (heavier than the problem — only these four tables need
the guarantee).

## R-04 · Detachment rather than deletion when the source disappears

**Decision**: evidence whose source becomes unavailable transitions to `detached`, keeping its
captured excerpt and a human-readable source label. Log rotation, a deleted branch or a purged
deployment record causes detachment, never removal.

**Rationale**: the conclusion drawn from that evidence still exists. Deleting the evidence would
leave a conclusion with no support, violating FR-009 retroactively and making the system look like
it invented the claim. A detached record with "from logs, March" is honest and still useful.

## R-05 · Excerpt bounding at capture time

**Decision**: excerpts are bounded at capture. Beyond the limit a bounded head-and-tail extract plus
a reference is stored, and the truncation is marked.

**Rationale**: a 40 MB stack dump inlined into an evidence row destroys query performance for every
view that touches the issue, and nobody reads the middle of it. Bounding later does not help — the
row is already written.

## R-06 · Producer attribution on every link

**Decision**: `evidence_link` carries the identifier of the step that asserted it and the time.
Writing a link attributed to a different step is rejected. There is no API for creating links
retrospectively.

**Rationale**: Principle I's real teeth. Without producer attribution, "the system concluded X
because of Y" is unfalsifiable; with it, a link created by a summarisation step rather than by the
step that observed the fact is detectable. This is the mechanism that makes post-hoc
rationalisation structurally impossible rather than merely discouraged.

## R-07 · Timeline and graph as deterministic queries

**Decision**: timeline, evidence graph and audit trail are SQL over `issue_event`, `evidence` and
`evidence_link`. The timeline additionally unions 012's `workflow_transition`, because the two event
tables hold different grains — domain facts here, machine steps there — and neither is total on its
own (C-14). Nothing is copied between them. No model orders, selects or summarises events.

**Rationale**: rendering the same issue twice must produce the same output (SC-005), and a
reordered sequence of events is a plausible-sounding lie. Prose summary over an already-correct
timeline is a separate, optional concern.

## R-08 · Merge is reversible; unmerge restores both evidence sets

**Decision**: merging records a `merged_into` relationship and a merge event; both evidence sets
remain attached to their original issues. Unmerge removes the relationship. Nothing is copied or
rewritten.

**Rationale**: two issues judged the same are sometimes not, and the judgement is often made at 3am.
Copying evidence into a survivor would make the operation lossy and the reversal impossible.

## R-09 · Ingestion idempotency and durability

**Decision**: each provider delivery carries an identifier recorded in `ingestion_delivery`; a
repeat is acknowledged and dropped. A signal that cannot be processed downstream is retained with
its parse failure recorded as evidence, and repeated failure is observable.

**Rationale**: providers retry, and an at-least-once source with a non-idempotent sink produces
inflated occurrence counts — which then drive the wrong diagnosis. Never dropping silently matters
because a lost signal is indistinguishable from an absent one.

## R-10 · Both observed and received timestamps

**Decision**: every signal and evidence record carries `observed_at` (source clock) and
`received_at` (ours). Ordering uses observed; retention uses received.

**Rationale**: clock skew between a customer's systems and ours is normal. Ordering by our clock
produces timelines where the fix precedes the failure; expiring by the source clock lets a skewed
provider keep data past its retention.

## R-11 · Stale issues are surfaced, not closed

**Decision**: an issue with no new signals and no progress for a configured period is marked stale
and surfaced. It is never auto-resolved.

**Rationale**: auto-closing produces a clean board and a false record. "Stopped happening" and
"was fixed" are different facts, and only the second belongs in the history the diagnosis engine
reads later.

## R-12 · Deletion records that it happened

**Decision**: tenant-requested deletion removes issue, evidence and audit content, leaving a
tombstone with the identifier, time and requester — no deleted content.

**Rationale**: the audit trail must show a gap was deliberate. A silently missing issue looks like
data loss during the next audit, and there is no way to prove otherwise afterwards.

## Unresolved

None.
