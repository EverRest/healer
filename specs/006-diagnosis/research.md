# Phase 0 Research: diagnosis

Each entry is a decision, why it was taken, and what was rejected. Nothing here is left open.

## R-01 · The classifier is a stage, not a field on the diagnosis

**Decision**: `ClassifyIssue` is its own command, its own workflow node and its own table. It runs
on the `ContextSnapshot` before `RunDiagnosis` is dispatched. `diagnosis.classification_id` is
`NOT NULL` and references a classification for the same issue.

**Rationale**: "classify first" expressed as field order inside one output schema is a sequencing
convention, and a model that returns all fields at once has already generated the hypotheses by the
time the verdict exists. With a separate stage, hypothesis generation cannot begin before the
verdict is written, and the ordering is a foreign key rather than a habit. The constitution puts
this gate ahead of hypothesis generation for a cost reason too (III): classifying after reproduction
means sandbox time spent on a Redis outage.

**Alternatives**: one model call returning `classification` plus `hypotheses` (ordering is
unenforceable and a refused verdict still paid for the hypotheses); classification as a post-filter
before handing to 008 (the wrong-problem patching failure mode is already fully priced by then,
`failure-modes.md` §5).

## R-02 · Deterministic signals first, model only to adjudicate

**Decision**: classification runs versioned signal rules over the snapshot's evidence before any
model call:

```text
dependency-class error signature in ≥2 unrelated components, same window  → third_party_outage
configuration or deployment change correlated, no code change in scope    → config_or_infrastructure_drift
saturation metric crossing its baseline before the first error            → capacity
deploy within the correlation window, first occurrence after it           → deploy_regression
```

Where exactly one rule fires and nothing contradicts it, the class and verdict are taken
deterministically and no model is called. Where none fires, the model adjudicates from the evidence
and returns a class from the closed list. Where two or more fire with different verdicts, the result
is `UNDETERMINED` with both classes and their evidence recorded — the gate fails closed.

The rule set is a versioned row (`classifier_ruleset`), and every classification records the version
that produced it, exactly as 001 R-01 does for fingerprints.

**Rationale**: constitution VIII — prefer deterministic tooling wherever the answer is derivable.
The four highest-value classifications (the non-code ones, which are the ones the gate exists for)
are derivable from evidence shape, and a rule that fires on evidence is explicable a year later.
Versioning as data means adding a rule does not change the gate's behaviour, which is what the
spec's own Assumptions promise.

**Alternatives**: model-only classification (SC-002 is a release gate at 2% false negatives, and a
prompt is a poor place to hold a threshold); rules-only (the long tail of code-bug classes is not
rule-derivable and would be forced into `UNDETERMINED`, closing the patch path on everything).

## R-03 · The patch path is closed by a view, not by a flag

**Decision**: `diagnosis.fix_eligibility` is a SQL view. For each issue it yields `eligible` and a
`blocked_by` array, computed from three independent facts:

```text
latest classification verdict = CODE_PROBLEM
AND an expectation_violation exists whose adopted_at < issue.first_seen_at
AND latest diagnosis outcome = ROOT_CAUSE_IDENTIFIED
```

Absence of any row yields `eligible = false` — literally, not by intent: the conjunction is wrapped
in `coalesce(…, false)`, because with no classification, violation or diagnosis row the three-valued
conjunction yields `NULL`, and a `NULL` read as a boolean by a consumer is not the safe direction.
The policy engine reads the view; 002 FR-005 makes the absence of a matching rule a `DENY`, so a
missing classification and a refused one produce the same outcome.

**The second conjunct is advisory, and this view grants nothing.** `pre_existing` is derived from
timestamps 006 itself copied onto `expectation_violation`, so it is a fact from inside the same chain.
**008's `anchor_resolution` is authoritative** for whether an anchor exists, names a live
`anchor_grant` and pre-dates the issue (008 R-04, C-12); 008 re-resolves against 005 and does not
inherit a positive claim from here. This view exists to close the patch path early and cheaply for
policy — a `false` is binding, a `true` is only "006 found nothing that blocks it".

**Rationale**: FR-002 requires eligibility to be a *structural fact available to the policy engine*.
A boolean column is a claim maintained by code, and code that maintains a security-relevant boolean
is one convenience method from being wrong. A view has no write path at all — the failure mode is
not "someone set it incorrectly" but "the view returns false", which fails in the safe direction.
The three conjuncts are independent: no single wrong answer opens the path.

**Alternatives**: a column updated in a transaction (writable); a policy rule that re-derives the
condition (duplicates the definition in two places, and they drift).

## R-04 · Expectation matching is deterministic retrieval, not a judgement call

**Decision**: the violated expectation is found by querying 005 with question type
`intended_behavior` (005 FR-004), restricted to expectation versions carrying a live `anchor_grant`
(005 data model, C-12) — **not** by a `state = adopted` predicate, because the grant is the only
thing that can name an anchor and `state` is a display column no anchor query reads — matched on the
structured constraint (005 FR-014) covering the failing component, endpoint or invariant. The
citation pins the document version (005 FR-019). The model may rank candidates; it may not create
one, and if no adopted entry matches, `NO_EXPECTATION` is recorded as a row.

**Rationale**: FR-009 says diagnosis identifies *which* adopted expectation is violated. A model
asked "what should this do?" answers, always — and that answer becomes 008's verification anchor,
closing the circle ADR 0002 exists to prevent. Retrieval can return nothing; generation cannot.

**Alternatives**: letting the model paraphrase the expectation for readability (a paraphrase is a
new statement, and it is the paraphrase the reviewer would read); falling back to a `draft`
expectation when no adopted one exists (D-20 forbids it, and an unadopted version carries no
`anchor_grant`, so it is unnameable rather than refused — which is the same reasoning as C-12).

## R-05 · The adoption timestamp is stored on the violation, not recomputed

**Decision**: `expectation_violation` carries `expectation_version_id`, `adopted_at` and
`issue_first_seen_at` as columns copied at write time, plus a derived `pre_existing` boolean. An
expectation adopted after the issue's first-seen time is recorded as `pre_existing = false` and is
valid context for the human but confers no eligibility.

**Rationale**: the spec's edge case and 008 FR-006 both turn on this comparison, and both read it
months later. Recomputing it at read time means it depends on 005's current adoption state, and an
expectation adopted today would retroactively make a three-week-old issue fix-eligible. Freezing
both timestamps makes the anchor's pre-existence a recorded fact, which is what constitution II
actually requires.

## R-06 · The disconfirming search is a record, not a field

**Decision**: every hypothesis has exactly one `disconfirming_search` row (`NOT NULL` foreign key
in the other direction: a hypothesis without one cannot be read as complete). It records what was
searched — evidence types, sources, time window, queries issued — and the outcome
`found` | `none_found`. `none_found` with an empty search description is rejected.

Promotion to root cause is blocked by a check: a hypothesis with `contradicting` evidence links and
no `contradiction_explanation` cannot be the diagnosis's root cause (FR-008).

**Rationale**: FR-007 requires an explicit "none found", and "none found" is only meaningful next to
what was looked for. A hypothesis with no contradicting evidence *considered* is the red flag; a
hypothesis with contradicting evidence considered and none found is a result. Storing only the
verdict makes those two indistinguishable, which is how a model builds a case instead of running an
investigation.

## R-07 · `UNKNOWN` and `INSUFFICIENT_CONTEXT` are evidence-backed conclusions

This is the entry the spec most needed checked: 001 FR-009 rejects any persisted conclusion without
an evidence reference, and "I don't know" is the conclusion most likely to have none.

**Decision**, by outcome:

| Outcome | What the diagnosis links to | Relation |
|---------|-----------------------------|----------|
| `UNKNOWN` — hypotheses refuted | the evidence records that refuted each one | `contradicts` |
| `UNKNOWN` — several remain supported and mutually exclusive | the supporting evidence of each surviving hypothesis | `supports` |
| `INSUFFICIENT_CONTEXT` | the `collection_gap` evidence records behind each missing item | `contextualises` |

003 already produces the gaps: a source that timed out or was unavailable is a `SourceOutcome`
(003 FR-014), an item the redactor could not clear is a `WithheldItem` (003 FR-009), and every one
is persisted as an `Evidence` record (003 FR-012) of type `collection_gap` — the type exists in
001's enum and in the runner contract's closed list (012 FR-022). So the link is to a real,
immutable record, not to an absence.

**The one hole, and its plug**: if diagnosis names a missing evidence item for a source 003 never
planned to collect, no gap record exists. Two steps close it — diagnosis may request one bounded
follow-up collection pass (003 FR-005), and where that pass cannot be planned or cannot run, the
**diagnosis step itself emits a `collection_gap` evidence record attributed to itself** (001 FR-008:
the producing step writes its own links). Every `missing_evidence_item` therefore resolves to an
evidence id, and SC-006 is checkable rather than aspirational.

**Rationale**: without this, the honest outcomes are the ones the evidence gate rejects, and the
system would be pushed toward answering — which is the failure mode the product exists to prevent.

**Alternatives**: exempting `UNKNOWN` from FR-009 (an exemption in the non-negotiable principle, for
the exact case where a wrong answer is cheapest to fake).

## R-08 · Precedents decay deterministically, and their conclusions are not representable

**Decision**: `precedent_candidate` stores `referenced_issue_id`, `similarity_basis`,
`similarity_score`, `age_days`, `liveness` and `evidence_ids` — and no column holding the past root
cause. Weight is arithmetic:

```text
weight = similarity × 0.5^(age_days / half_life) × liveness_factor
liveness_factor: present 1.0 · moved 0.5 · absent 0.0
```

`liveness` is a **graph** question, defined in R-19 — not a code-intelligence query (C-22). `absent`
sets weight to zero and marks the precedent stale; a stale precedent may be shown to the human and
MUST NOT appear as supporting evidence for a root cause — enforced by rejecting an `evidence_link`
whose evidence comes from a stale precedent's set.

Half-life and similarity threshold are configuration tuned on the stage-0 audit, not constants.

**Rationale**: `failure-modes.md` §6 is silent, so it needs structure rather than care. Two things
cause the harm: the conclusion priming the model, and a match that is no longer about live code.
Deleting the conclusion column removes the first entirely — there is nothing to prime with — and
liveness handles the second. Citing the precedent's own evidence (FR-020) is still permitted,
because that evidence is an observation and observations do not go stale the way conclusions do.

**Alternatives**: showing the conclusion with a "stale" badge (badges do not survive contact with a
prompt); a similarity threshold alone (a perfect match against three-refactors-ago code is the worst
case, not the best).

## R-09 · Confidence is isolated by storage, not by discipline

**Decision**: model-reported confidence is written to `diagnosis_confidence`, a sibling table keyed
by diagnosis id, exposed only on the evaluation read path (011). `packages/domain/policy/**` and the
`fix_eligibility` view do not reference it, enforced by the existing pattern-based import rule (012
FR-002, FR-003). SC-005 is a differential test: two runs whose inputs differ only in recorded
confidence produce identical eligibility rows and identical policy decisions.

**Rationale**: FR-015 and constitution IV. A column on `diagnosis` is available to every query that
already selects the row, and "available and forbidden" decays into "used, for ordering, harmlessly"
and then into a threshold. A separate table plus one import pattern is less machinery than a gate
that parses predicate inputs, and the differential test proves the property rather than asserting it.

## R-10 · Attempts are capped at the database

**Decision**: `diagnosis` is unique on `(issue_id, attempt_no)` with a check `attempt_no <= 2`. The
second `REJECT_DIAGNOSIS` (008 FR-017) escalates to a human carrying both attempts; a third insert
fails as a constraint violation rather than as a policy decision.

**Rationale**: D-08 bounds the loop, and `failure-modes.md` §9 is cost runaway dressed as diligence.
The cap belongs where it cannot be retried around. Escalation caps in 002 (FR-013) govern model
tier; this one governs the attempt count and is cheaper to enforce here than to express as a rule.

## R-11 · Exclusions carry over by statement fingerprint

**Decision**: every hypothesis carries `statement_fingerprint` — a hash over the normalised
statement: lowercased, identifiers and literals stripped, symbol references resolved to 004
component and symbol identifiers. Re-diagnosis receives the rejection reason and the refuted
fingerprints; a regenerated hypothesis matching an excluded fingerprint is recorded with its
`exclusion_reason` rather than re-argued.

**Rationale**: FR-024 requires exclusions to be recorded rather than regenerated, and a second model
run paraphrases by default. Exact-string exclusion is defeated by any rewording, so the cap would
buy a second attempt at the same wrong answer in new words. The technique is 001's fingerprinting
applied to a different string.

## R-12 · Budget exhaustion is a termination reason, not a fifth outcome

**Decision**: FR-012's four outcomes stay closed. A run stopped by budget (002 FR-011) or by the
escalation cap (002 FR-013) persists outcome `INSUFFICIENT_CONTEXT` with
`termination_reason = budget_exhausted | escalation_cap`, the established findings, the refuted
hypotheses, and an `unexamined` list naming what was not reached.

**Rationale**: adding a fifth outcome makes every consumer — 002, 007, 008, 009, 011, the dashboard
— handle a case that means exactly what `INSUFFICIENT_CONTEXT` already means downstream: not
eligible, route to a human, here is what is missing. The distinction that matters is *why* it
stopped, which is one column, and the human needs it. Two states that behave identically should not
both exist.

## R-13 · The directive suggests a rung; it never sets the starting rung

**Decision**: `reproduction_directive` carries `suggested_rung` and `max_rung`, not a single target.
007 always begins at the cheapest rung and never exceeds `max_rung`. The rung vocabulary is frozen
in [007's ladder contract](../007-reproduction-and-sandbox/contracts/ladder.md); this feature
imports it and does not restate the values.

**Rationale**: FR-017 names a suggested rung and a maximum rung rather than a single target, because
007 FR-002 says the engine MUST attempt cheapest first and stop at the first rung that reproduces. A
single "target rung" read as a start position contradicts that; a ceiling plus a hint does not: diagnosis contributes
what it knows (a concurrency bug will not reproduce at the unit rung) without overriding the
economics that 007 owns, and SC-002's "no rung above the reproducing rung was attempted" stays
true. Restating the enum in both specs would create two vocabularies that drift on the first change.

## R-14 · Injection containment: bind tools before loading, record rather than strip

**Decision**: the investigator agent's tool set is resolved from its capability-scoped credential
before the snapshot is loaded, and no snapshot content can alter it. Its capability bundle
(ADR 0008) contains no `RepositoryWriteCapability` and no `DraftPublishCapability`, so FR-010 — no
authoring or amending an `ExpectedBehavior` — is enforced by an unreachable function rather than by a
refusal path that could be added incorrectly. Snapshot excerpts are rendered into a delimited data
region with no instruction-bearing role. Content matching instruction shapes is recorded as a
`diagnosis_anomaly` of kind `instruction_shaped_content` and **kept**, not removed.

**Rationale**: FR-021 and `security-posture.md`. Permissions come from what the tools grant, not
from what the prompt says, so ordering the resolution before the load makes the prompt's content
irrelevant to authority. Stripping is the wrong instinct: a removed injection attempt is an
undetected attack on the customer, and the excerpt is evidence.

## R-15 · Component names resolve against a pinned graph version, or are dropped

**Decision**: affected components are resolved against the graph version pinned for the run (004
FR-014). Names that do not resolve are dropped from the structured output and recorded as a
`diagnosis_anomaly` of kind `unknown_component`. Blast radius derived from unconfirmed edges may
only widen (004 FR-016a, C-03).

**Rationale**: FR-016. An invented component name propagates into impact analysis (008 FR-001) and
into policy scope (002 FR-007), where it either matches nothing — silently narrowing what the change
appears to touch — or creates a phantom. Dropping loudly is the only safe direction.

## R-16 · `knowledge_drift` issues never reach this feature

**Decision**: diagnosis is not invoked for issues of kind `knowledge_drift`; 001 FR-001a terminates
them at human adjudication. Where an ordinary issue is found mid-diagnosis to be a knowledge
conflict — code and adopted expectation disagree, code behaving as users want — the run completes
with verdict `NOT_A_CODE_PROBLEM`, class `knowledge_drift`, and publishes `DiagnosisFoundKnowledgeDrift`
for 005 FR-016.

This requires `knowledge_drift` to exist as a class. It is now in FR-001's list, in
`classifier_ruleset.classes` and in the contract's closed enum — never free text.

**Rationale**: the spec's edge case demands an outcome the spec's own class list cannot express. The
alternatives are worse: a free-text class breaks FR-001's closed set, and forcing it into
`config_or_infrastructure_drift` mislabels the incident permanently in the corpus 011 measures.

## R-17 · Evidence support is a structural referent check, not a judgement

**Decision**: a claim is *supported* by an evidence record when every **referent** the claim names —
component id, concept id, topic key, signal type, deployment id, error signature — appears in that
evidence record's structured payload. The check is deterministic set containment over identifiers.
A claim naming a referent no cited evidence contains is not supported, and the link cannot be written.

Prose similarity is explicitly not used, and no model participates.

**Rationale**: FR-014, SC-003 and constitution II require that citing is not grounding — but the
obvious implementations are both wrong. A model judging support is self-review (failure-modes §1 and
§3). Keyword matching over prose accepts a citation that shares vocabulary with the claim while
saying the opposite. Identifier containment is weaker than semantic entailment and that is the point:
it is checkable, it cannot be argued with, and it catches the failure that actually happens — a
conclusion about component A cited to evidence about component B.

**Consequence, stated honestly**: this cannot detect a claim that names the right referents and draws
the wrong inference from them. That case is what the adopted expectation and the independent verifier
are for. Layered defences, not one sufficient one.

**Alternatives**: an entailment model (self-review with extra steps); human spot-checks only (does not
scale and gives no gate).

## R-18 · Affected components are stored, with the graph version that resolved them

**Decision**: `diagnosis_affected_component` — `diagnosis_id`, `component_id`, `relation`
(`primary` · `dependency` · `dependent`), `resolved_from_edge_path` jsonb, `confidence_class` (004's
edge provenance, **not** model confidence — R-09 keeps that out of every policy-reachable table).
Resolution reads an `ImpactClosure` from 004 at the pinned `diagnosis.graph_version`, so the set is
reproducible. A component that has since been removed from the graph is retained in the row and
flagged (`removed_from_graph`), never silently dropped.

**Rationale**: the contract returns `affectedComponentIds` and nothing held them. Storing the edge
path with them is what lets someone a month later ask why a component was considered affected, which
is the same requirement as evidence provenance.

## R-19 · Precedent liveness is asked of the graph, not of code intelligence

**Decision** (C-22): liveness is resolved against the current graph version (004), and the three
values have exactly these conditions:

```text
absent   the component or concept the precedent referenced no longer exists in the
         current graph version              → liveness_factor 0.0, stale = true
moved    it exists, but not where the precedent referenced it — a different component,
         a renamed concept, a re-parented node  → liveness_factor 0.5
present  it exists, where the precedent referenced it        → liveness_factor 1.0
```

Code intelligence is not consulted. Where the graph cannot be read at all, the anomaly
`precedent_liveness_unavailable` is recorded and the precedent is treated as `moved` — less weight,
never more.

**Rationale**: diagnosis is control plane and code intelligence is execution plane; asking whether a
symbol still exists would mean a runner round trip on every precedent lookup, for a weight
adjustment. The graph already answers the question that matters — does this part of the system still
exist — and it answers it locally. Stating the three conditions is what makes `absent` reachable:
without them nothing sets `stale`, and FR-019 and SC-007 could never fire.

**The cost, stated**: a deleted symbol inside a component that still exists reads as `moved`, not
`absent`. That is the safe direction — less weight for a precedent that may be dead, never more for
one that is.

**Alternatives**: a code-intelligence query per precedent (a plane crossing and a latency cost for a
scoring nudge); ignoring liveness (a precedent from a deleted component keeps anchoring diagnoses,
which is failure-modes §6).

## R-20 · Diagnosis records where the symptom is observable

**Decision**: the reproduction directive carries `observableLocation` ∈ `server` · `client` ·
`undetermined`, derived deterministically from the evidence: a server exception, a status code or a
server-side metric yields `server`; a browser error report, a client-side exception, a rendered-state
complaint or a report naming no server-side failure yields `client`. Evidence on both sides yields
`server` — the cheaper ladder is tried first, and a `FAIL` there is the better outcome.

`undetermined` is a real value. 007 turns it into `INCONCLUSIVE` rather than guessing, because a guess
costs a full browser run to learn nothing.

**Rationale**: 007's ladder is selected by this field (007 R-22), and who reported an issue does not
predict which instrument can see it — a user report often has a plainly server-observable symptom, and
an alert can fire from a client-side error reporter.

**Alternatives**: letting 007 infer it (007 receives the directive, not the full evidence set);
deriving it from `issue.kind` (kind does not predict location, which is the whole point).

## Unresolved

None.
