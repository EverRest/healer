# Phase 0 Research: context resolution across the hybrid boundary

Each entry is a decision, why it was taken, and what was rejected. Nothing here is left open.

## R-01 · Where the split falls, and what each side is allowed to decide

**Decision**: the control plane decides **what to collect** and **how to rank it**; the execution
plane decides **nothing**. The runner receives a `collection_plan` directive naming declared
collectors with schema-validated parameters, runs them, redacts, and returns a result batch. It
makes no selection, applies no relevance judgement and drops nothing on its own initiative except
where a redactor cannot clear an item.

**Rationale**: the two halves have opposite constraints. Planning and ranking must be versioned,
replayable and auditable by us (FR-004, FR-019) — properties we cannot assert about code running on
someone else's machine at a version we do not control. Collection and redaction must see raw
customer data, which is the one thing that must not reach us (FR-002, FR-007). Putting judgement in
the runner would mean the evidence set depends on the runner's version, and 012's compatibility
window (C-02) explicitly permits a runner two minor versions old.

**Alternatives**: a smart runner that selects what looks relevant (the evidence set becomes a
function of the deployed runner version, and SC-007 becomes untestable); collection from the control
plane over a tunnel (requires us to hold customer observability credentials, which FR-002 forbids
and which is the deal-killer ADR 0001 exists to avoid).

## R-02 · One boundary schema, validated twice

**Decision**: `packages/boundary-contract` holds the Zod schemas for every crossing shape and is
imported by the runner's egress validator and by the control plane's ingress validator. Two
executions, one definition. The schema carries the contract version, and both sides record which
version they validated against.

**Rationale**: 012 FR-022 requires validation at egress on the runner *and independently* at ingress
on the control plane. "Independently" is about the execution — a compromised or buggy runner must
not be trusted to have validated — not about the definition. Two definitions drift, and a drifted
boundary schema fails in the worst direction: a field the runner believes is declared and the
control plane has never seen, or the reverse, silently dropped.

**Alternatives**: schema generated from an IDL at build time for each side (more machinery for the
same guarantee); each side owning its own copy (drift, discovered by a customer).

## R-03 · Conformance to the runner protocol, and the three lists that do not agree

**Decision**: [012 `contracts/runner-protocol.md`](../012-engineering-foundation/contracts/runner-protocol.md)
is the authority for crossing shapes. This feature transmits `error_signature`, `trace_shape`,
`metric_delta`, `deploy_ref`, `commit_ref`, `test_result`, `file_path`, `pull_request_ref`,
`config_key_ref`, `knowledge_ref`, `tool_output_summary` and `collection_gap`, and adds none.
Pull-request metadata, configuration and feature-flag key names, and knowledge and issue references
each have **their own declared shape** (C-20): `pull_request_ref`, `config_key_ref` and
`knowledge_ref`, added to 012's closed set alongside 004's four graph shapes. They do **not** ride as
`tool_output_summary` — 012's own contract text says reusing that shape reopens the free-form channel
it exists to close, and a closed list with an escape hatch is not closed.

**Rationale**: [012 contracts/runner-protocol.md](../012-engineering-foundation/contracts/runner-protocol.md)
is the **single authority** for the closed list — 012 FR-022 no longer restates it, so the three-way
divergence that motivated this entry is gone. A feature that adds shapes locally would give the
product two closed lists, which is one too many. The contract wins because it is the artifact a
customer's security review reads (012 plan.md). FR-006 now defers to that shape set outright, and the
item taxonomy survives only as the non-normative crosswalk in `contracts/collection-plan.md`.

**Residual cross-spec item**: stack-frame facts. The crosswalk maps stack frame paths, symbols and
line numbers onto `file_path`, whose declared contents in 012 are "repository-relative path — not
file content" — which has room for neither a symbol nor a line number. 012 must either extend
`file_path`'s contents or declare a `stack_frame` shape. Until it does, the crosswalk is what this
feature builds against and the extra fields are not transmitted.

**Alternatives**: adding the missing shapes to the boundary schema from this spec (the closed list
stops being closed the moment any feature can extend it).

## R-04 · The requested plan is deterministic; the resolved plan records what the runner could do

**Decision**: planning is two stages.

1. **Requested plan** — a pure function of `(issue kind, component, environment, first_seen_at,
   collection_ruleset version)`. No capability input, no clock, no model. Content-addressed as
   `plan_digest`.
2. **Resolved plan** — `requested ∩ runner capabilities` (012 R-03). Collectors dropped by the
   intersection are recorded as `not_attempted` source outcomes with reason
   `capability_unavailable`, and the resolution is written to `runner_capability_resolution` (012).

**Rationale**: SC-007 requires identical issues to produce identical plans, and a capability set
that varies with the deployed runner version would make that untestable — while pretending
otherwise would hide a degraded collection. Separating the two keeps determinism a property of the
requested plan, where it is meaningful, and makes degradation explicit where it actually happens.
It is also the read-path half of C-02: a missing read capability degrades and records; it never
refuses.

**Alternatives**: one plan computed against live capabilities (determinism is unverifiable);
refusing to collect when a capability is missing (fails closed exactly when observability is least
healthy, which Story 3 exists to prevent).

## R-05 · The plan digest is the idempotency key

**Decision**: a collection pass is keyed on `(issue_id, plan_digest, pass_ordinal)`. A retried or
duplicated dispatch with the same key returns the existing pass; a duplicated result batch for a
pass already ingested is acknowledged and dropped, exactly as 001 R-09 treats provider deliveries.

**Rationale**: FR-026 requires idempotency per issue and plan, and the plan already hashes to a
stable value for determinism reasons (R-04). Reusing it costs nothing and removes a second key that
could disagree with the first. Under BullMQ's at-least-once delivery (ADR 0003) a dispatch will be
duplicated eventually, and duplicated evidence records inflate occurrence counts — which then drive
the wrong diagnosis, the same failure mode 001 R-09 describes for ingestion.

## R-06 · Parallelism lives inside the runner, not as fan-out of control-plane jobs

**Decision**: one directive out, one result batch back. The runner runs collectors on a bounded
concurrency pool with a per-source timeout; a source that exceeds it contributes what it returned,
marked `partial` and truncated (FR-016). The control plane waits on one persisted state with one
`runner_result` callback (012 FR-029, 012 FR-030).

**Rationale**: fan-out in the control plane would mean N boundary crossings, N idempotency keys and
a join the control plane has to hand-roll before it can finalise a snapshot — and, fatally, it would
require the control plane to address each collector, which means holding credentials for them
(FR-002). The parallelism belongs where the latency and the credentials already are. One batch also
makes the snapshot's atomicity trivial: it is finalised when the batch lands or when the deadline
fires, and never in between.

**Alternatives**: a job per collector (violates FR-002, and multiplies the crossings that must be
validated and audited); sequential collection (Story 2 — context that arrives after the incident is
over).

## R-07 · Every non-`collected` source produces a `collection_gap` evidence record

**Decision**: the six source outcomes of FR-014 — `collected`, `partial`, `unavailable`,
`timed_out`, `withheld`, `not_attempted` — map to evidence as follows: `collected` produces its
items; every other outcome produces exactly one `collection_gap` evidence record carrying the
collector key, a reason code from a closed set, the attempt duration, and the item count where one
exists. The snapshot's completeness descriptor is a projection of these records, not a second store.

**Rationale**: this is what makes the honest-unknown path persistable. 006 FR-013 requires an
`INSUFFICIENT_CONTEXT` outcome to name the specific missing evidence, and 001 FR-009 requires every
persisted conclusion to reference at least one evidence record. "We could not reach the metrics
backend" is only a citable fact if it is a record; without it, "unknown" is a conclusion with
nothing behind it and persistence fails. The gap record is therefore not bookkeeping — it is the
evidence that an absence was observed rather than assumed.

Reason codes are enumerated (`source_unreachable`, `auth_revoked`, `timeout`, `retention_exceeded`,
`capability_unavailable`, `budget_exhausted`, `redaction_withheld`, `schema_rejected`,
`empty_result`), because a downstream step has to branch on them: credentials revoked and a source
simply empty are different facts (spec edge case), and only one of them is a configuration problem —
which is exactly why `empty_result` is a code of its own and not a flavour of `unavailable`.

**Alternatives**: a status field on the snapshot only (machine-readable, but not citable, so 006
cannot link to it); a log line (invisible a month later).

## R-07a · The initial redaction detector set

**Decision**: the redaction ruleset ships with a named, versioned detector set, and an item is
cleared only when **every** detector that fires on it can be satisfied by replacement. Initial set:

| Detector | Clears by | Fails closed when |
|----------|-----------|-------------------|
| `email_address` | replace with a stable per-tenant pseudonym | — |
| `bearer_token` | remove the whole value | always removes, never replaces |
| `private_key_block` | remove the whole item | any PEM-style header present |
| `connection_string` | remove credential segment, keep host and database name | credential segment cannot be located |
| `ip_address` | keep network portion, drop host portion | — |
| `uuid_in_message_position` | replace with a positional placeholder | — |
| `numeric_identifier_run` | replace with a length-preserving placeholder | run is inside a word boundary we cannot classify |
| `payment_instrument` | remove the whole item | any Luhn-valid run of 13–19 digits |
| `national_identifier` | remove the whole item | any configured per-country pattern matches |
| `free_text_span` | **never clears** — a span the other detectors did not structure is withheld | always |

`free_text_span` is the important row: it is why the set can be incomplete without being unsafe. A
detector set is never finished, so the default for unstructured text is withholding rather than
"no detector fired, therefore safe".

**Rationale**: FR-008 and FR-009 turn on what the ruleset can clear, and an unnamed detector set
makes those requirements untestable. Naming them makes the gaps visible: the set is versioned, each
version records what it can clear, and a `collection_gap` names the detector that failed rather than
saying "redaction failed".

**Alternatives**: a denylist of forbidden patterns (a denylist is never complete, and its
incompleteness is invisible); clearing anything no detector matched (inverts the safe default and is
how customer data escapes).

## R-05a · A follow-up may only name paths already in the snapshot

**Decision**: the `source_file` collector's `parameters` are validated in the **control plane before
dispatch** against the set of repository-relative paths already present in the snapshot — stack-frame
paths, changed paths from correlated commits, paths named in an existing evidence record. A path
outside that set is refused, and the refusal is recorded.

**Rationale**: without this, the follow-up mechanism is an arbitrary file read inside the customer's
network chosen by a model. The count cap bounds how many reads happen, not which — and "which" is the
whole risk. Constraining to paths the investigation already surfaced keeps the mechanism useful for
its actual purpose (reading the function in the stack trace) while removing the arbitrary-read
property entirely.

**Alternatives**: an allowlist of directories (a model can still name any file inside one, and the
list drifts toward permissive); auditing after the fact (the read has happened).

## R-08 · Withheld items keep a plane-local reference the control plane cannot resolve

**Decision**: when the redactor cannot establish an item is safe, the runner writes it to a
plane-local `withholding_ledger` keyed by a fresh UUID and transmits only
`{ localRef, itemClass, reasonCode, collectorKey, observedAt }` inside a `collection_gap`. The
ledger lives in the customer's plane, expires on their retention, and is resolvable by a human there
through `make runner-resolve-ref <uuid>`. The control plane holds a reference it is structurally
unable to dereference.

**Rationale**: FR-009 and Story 1 scenario 5 require the original to be resolvable locally, and 012
R-05 requires withholding rather than best-effort truncation — a partially redacted excerpt is still
customer data. A reference we could resolve would make the withheld content reachable from our side,
which is exactly the property withholding exists to remove. An opaque UUID satisfies both: honest
about what was not sent, useless to us.

Redaction-dominated items (the excerpt survives but carries no signal) are a different case: they
are **kept**, with their structured derivatives, flagged `redaction_dominated`, so a human knows to
look locally rather than concluding there was nothing there.

**Alternatives**: transmitting a truncated excerpt (012 R-05 forbids it, and truncation is not
redaction); dropping the item entirely (a silent hole, which is the failure Story 3 exists to
prevent).

## R-09 · Ranking is a sum of named integer terms, with a total order

**Decision**: relevance is `sum of term weights` from a versioned `ranking_ruleset`, where each term
is named and its contribution is stored on the item: temporal proximity to first-seen, source trust
rank from the constitution's hierarchy, occurrence-count band, component match strength, deploy- and
change-window overlap, and stack-frame path match. Weights and contributions are integers. Ordering
is the total order `(score desc, observed_at asc, evidence_id asc)`.

**Rationale**: FR-019 requires explainable, and a single float is not an explanation — "0.72" gives
an engineer nothing to disagree with, whereas "+40 inside the deploy window, +25 observed source,
−10 outside the component" gives them a weight to argue about. Integers because SC-007 requires
identical ordering across runs and floating-point summation is order-sensitive in its low bits. The
explicit tiebreak because "sort by score" is non-deterministic the first time two items tie, and the
database's natural order is not a promise.

Ranking terms are computed from **structural metadata only** — timestamps, counts, source identity,
paths, component identifiers — never from item text. That is one half of FR-021 (see R-11).

**Alternatives**: a learned or model-assigned relevance score (a model choosing what the diagnosis
ever sees, which is the invisible filter FR-004 and Story 6 exist to prevent); normalised floats in
[0,1] (prettier, order-unstable).

## R-10 · Deduplication reuses 001's normalisation ruleset

**Decision**: the dedup key is `(item_class, normalised_signature, component, environment)`, where
the signature is produced by 001's `normalisation_ruleset` at the version the item records (001
FR-003, 003 FR-018). Duplicates collapse to one representation with an occurrence count and
first/last observed times. No second normaliser exists in this feature.

**Rationale**: if context deduplicated with different rules from issue fingerprinting, two items the
issue layer considers the same failure could appear as two distinct context items — and the
occurrence count the diagnosis reads would disagree with the occurrence count on the issue. One
normaliser, versioned as data, explicable a year later (001 R-01).

## R-11 · Collected content is data, enforced by a type and by a differential test

**Decision**: two mechanisms, both nearly free.

1. **Type**: an excerpt is a branded `Untrusted<string>`. The planner, the ranker, the dedup key
   builder and 002's `DecisionInput` (002 R-03) have no parameter that accepts it, so `make
   typecheck` rejects a path from collected text into a predicate. The only consumers are the
   prompt assembler, which wraps it, and the read surface, which renders it marked.
2. **Differential test**: the injection corpus runs twice, with and without instruction-shaped
   strings in every source. Plan digest, item ordering, policy decisions and tool invocations must
   be byte-identical (SC-010).

**Rationale**: FR-021 is a security property, and a security property asserted only in review decays
with every new caller. The type catches the new caller at compile time; the differential test
catches the path the type system could not see — a string that reaches a model and changes what the
model asks for next. Together they cover both the structural and the behavioural half of the
attack described in the constitution's Security Model.

**Alternatives**: sanitising or stripping instruction-shaped text (a denylist over natural language
is never complete, and stripping destroys the evidence that an injection was attempted — which is
itself something a customer wants to see).

## R-12 · Follow-up passes are a typed request, not a query string

**Decision**: a downstream step (006) may request additional collection by naming a
`collectorKey` from the registry with parameters validated against that collector's schema. The
key's type is an enum over the registry, so a source outside the declared set is not expressible.
Requests are capped per issue by configuration, and each becomes its own `collection_pass` with the
requesting step and reason recorded. Named-file source retrieval (FR-011) is simply the `source_file`
collector, reachable only this way, so it inherits the cap, the schema validation and the audit
entry rather than being a second mechanism.

**Rationale**: FR-005 requires that a request cannot name an undeclared source. The request
originates from a model's structured output, so the guarantee has to hold against an adversarial
value — and an enum field makes the undeclared source unrepresentable, while a string field with a
validator makes it a validation bug away from possible. Routing FR-011's file retrieval through the
same mechanism removes a path that would otherwise need its own cap and its own audit.

**Alternatives**: a free-form query the runner interprets (arbitrary read execution inside the
customer's network, requested by a model — the exact shape the constitution's "no raw shell access"
rule forbids for tools).

## R-13 · Ingress rejection stores schema errors and a digest, never the payload

**Decision**: a payload failing boundary validation at ingress is rejected before any domain write
and recorded in `boundary_rejection` as `(contract_version, runner_id, schema_error_paths,
payload_digest, byte_size, received_at)`. The payload itself is not stored anywhere. Rejection
counts are visible to the tenant (FR-010, 012 FR-022).

**Rationale**: a payload that failed boundary validation is precisely the payload that may contain
what the boundary exists to keep out. Storing it "for debugging" would mean the one code path
guaranteed to handle non-conforming data is also the one that persists it — defeating the boundary
at the exact moment it was working. The error paths and the digest are enough to diagnose a schema
mismatch, and the runner's own diagnostic bundle (012 R-06) covers the rest from the side that may
legitimately see it.

**Alternatives**: quarantining the payload in a restricted table (still customer data at rest in our
plane, still in a DPA, still discoverable — the same argument that rejected retained fixtures in
C-04).

## R-14 · Contradictions are surfaced, never resolved

**Decision**: when two collectors return facts that disagree on a declared comparable field — the
deploy tool reporting v2 live and the runtime reporting v1 — both items are retained as evidence and
the snapshot's completeness descriptor carries a `contradictions` list naming the two item
identifiers and the field. No collector is preferred, no item is dropped, and nothing here decides
which is right.

**Rationale**: a contradiction between observability sources during an incident is frequently the
diagnosis. Picking one would discard the finding and produce a confident snapshot built on a coin
flip. Surfacing it as a structured field rather than a table keeps it where the consumer already
looks — the completeness descriptor is the thing 006 reads before deciding whether it may conclude
(FR-017).

## R-15 · Budget exhaustion finalises rather than fails

**Decision**: when the per-issue or per-tenant budget is exhausted mid-run (002 FR-011), the
snapshot is finalised from what was collected, marked `budget_limited`, and every uncollected source
is recorded `not_attempted` with reason `budget_exhausted` — each producing its gap record. At a
soft threshold, the degradation entry from the declared order (002 FR-012) narrows the requested
plan for the *next* pass; it never rewrites a pass in flight.

**Rationale**: 002's edge case requires a workflow to suspend resumably rather than fail, and work
already done not to be discarded. A half-collected snapshot that is honest about being half
collected is strictly more useful than no snapshot, and FR-015 already requires one whenever at
least one source was attempted. Narrowing only the next pass keeps a pass reproducible from its own
plan digest.

## Unresolved

None.
