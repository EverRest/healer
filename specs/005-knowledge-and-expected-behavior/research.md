# Phase 0 Research: knowledge sources, provenance and expected behaviour

## R-01 · Anchor eligibility is a row, not a state check

**Decision**: adoption writes one row to `anchor_grant`, keyed to an `expected_behavior_version`.
The verification path in 008 references `anchor_grant.id` — not `expected_behavior.id` and not a
state column. There is no query in the system that decides anchor eligibility by reading
`expected_behavior.state`.

**Rationale**: the obvious design is a `state` enum with `WHERE state = 'adopted'` at the anchor
lookup. That is a predicate a future query can omit, and the consequence of omitting it is a
verification that passes against an expectation Healer wrote itself — Principle II void, with every
gate still green. Making the grant a row inverts the failure: an unadopted expectation has no grant,
so there is nothing for a verdict to reference. The wrong code does not produce a wrong answer; it
produces a foreign key that resolves to nothing.

Three requirements then fall out of the same table rather than needing their own mechanisms:

- **FR-012** — editing an adopted entry creates a new version, which has no grant, so the previously
  adopted version remains the anchor until its own adoption. No versioning logic in the anchor path.
- **FR-013** — revocation writes `revoked_at`. The anchor lookup filters `revoked_at IS NULL`, so it
  takes effect on the next request; a completed verification's stored `anchor_grant_id` still
  resolves, so its audit record stays intact and readable.
- **SC-001** — the invariant is a join, not a scan over conclusions: every anchor reference resolves
  to a grant, and every grant resolves to an adoption record naming a human.

**Alternatives**: a state machine with an application guard (the guard lives at one call site and
every new consumer is a new omission); a database rule rejecting anchor writes for non-adopted rows
(better than a guard, but it still lets the wrong identifier be *named*, so the error surfaces at
write time rather than being unrepresentable).

## R-02 · Adoption happens in code review, and Healer cannot approve

**Decision** (C-06): an `ExpectedBehavior` lives as a YAML front-matter block in a markdown file in
the customer's repository. The write path (FR-021) opens a **merge request**; it never commits to a
default branch. Adoption is recorded when that merge request is approved and merged, with
`adoption_record.actor` taken from the VCS approval record and `adopted_version` from the content
hash at the merge commit.

A check rejects an adoption whose approver identity equals Healer's own service account, and the
GitLab credential Healer uses to open merge requests does not hold approval permission (constitution
security model — permissions are what tools grant).

**Rationale**: C-06 says the adoption gate *is* code review. That is only true if Healer cannot pass
its own gate. Healer opens the merge request, so the one place a machine could adopt its own anchor
is the approval, and it has to be closed on both sides: the credential must lack the permission, and
the recorded approver must be checked, because a customer may later widen a token by accident.

Beyond the gate, the repository gives the two other things a hosted wiki would have cost an adapter
to provide: **freshness** from the last commit touching the file, and **authorship** from the commit
author — both exact, both free, neither self-reported.

**Alternatives**: an in-product adopt button (it invents an approval workflow the customer already
has, and R-16 defers it out of v1 entirely rather than shipping it beside the merge-request path);
a hosted-wiki adapter (C-06 rejects it for v1: full adapter cost, and it supplies neither freshness
nor an approval gate).

## R-03 · Two ranking functions, no default, no shared entry point

**Decision**: `RetrievalQuery` carries a required `questionType` discriminator. Dispatch is to
`rankCurrentBehavior` or `rankIntendedBehavior`. There is no `rank(query)`, no default parameter and
no fallback branch. A request arriving without the discriminator fails schema validation before it
reaches the query layer (FR-004).

**Rationale**: the spec says an undeclared question type is refused. A default is a declaration
nobody made, and the two orderings are near-inverses — answering "how many retries does checkout do"
under the intended-behaviour ordering returns the wiki's five instead of the observed three, which is
exactly the misdiagnosis this feature exists to prevent. A refused query is a visible failure; a
defaulted one is a confident wrong answer, which is this product's defining failure mode.

The same discipline as 004 R-05: the dangerous behaviour is not checked, it has no callable form.

## R-04 · Trust tiers are versioned rows, and the ordering is total

**Decision**: `trust_tier_rule` holds one rule set per question type, versioned. A rule maps a
document class — observed evidence, code, test, verified incident, adopted expectation,
human-authored document, machine-generated document — to an integer tier for that question type.
Ranking is:

```text
ORDER BY tier ASC,
         score DESC,                       -- within-tier relevance
         document_version.captured_at DESC,
         document_id ASC                   -- makes the order total
```

Every result carries `tier`, `ruleId` and `ruleSetVersion` (FR-006).

**Rationale for versioning**: SC-005 requires identical query and corpus to produce identical
ranking, and a tenant tunes within-tier weights (spec assumptions). Without a version on the rule
set, tuning silently rewrites the meaning of every past explanation and every stored
`retrieval_query` record becomes unreproducible.

**Rationale for the final tie-break**: without `document_id ASC` the ordering is only a partial
order, and two results with equal tier, equal score and equal capture time come back in whatever
order the plan produced — which changes with the plan, not with the corpus. SC-005 would fail
intermittently, which is the worst way for it to fail.

## R-05 · Embeddings are partitioned by tenant, so ANN is not a post-filter

**Decision**: `section_embedding` is declaratively list-partitioned on `tenant_id`, with an HNSW
index per partition. An ANN search runs inside one tenant's partition, selected by the mandatory
`tenant_id` from the authenticated context.

**Rationale**: FR-027 forbids retrieval across tenants followed by filtering, "by construction". A
single global HNSW index with `WHERE tenant_id = $1` is exactly that construction: the index scan
returns a global top-k and the filter removes what does not belong. Besides being the prohibited
shape, it has a recall bug attached — a small tenant whose sections never enter the global top-k
gets zero results and no error. Partitioning makes the isolation structural and the recall
per-tenant correct, at the cost of one index per tenant, which at tens of tenants is nothing.

The same reasoning does not apply to the lexical and structural paths: those are ordinary btree and
GIN scans where `tenant_id` leads the index, so the predicate is applied inside the scan rather than
after it.

**Alternatives**: one index with an over-fetch factor and a filter (still post-filtering, and the
factor is a guess that fails for the tenant it fails for); a per-tenant table (a partition is the
same thing with one DDL path and one query).

## R-06 · Three retrieval paths; the vector one is droppable

**Decision**: a query runs three paths and unions their candidates before ranking:

| Path | Mechanism | Answers |
|------|-----------|---------|
| Structural | identity joins on component, feature, endpoint, constraint name, file path | "the expectations for checkout" |
| Lexical | `tsvector` + GIN full-text with the query's terms | "retry limit" |
| Vector | pgvector HNSW over section embeddings | paraphrase and synonym recall |

`section_embedding` carries no content and can be truncated and rebuilt from `document_section` at
any time. `make check:retrieval-without-vector` runs the corpus suite with the index dropped
(SC-004).

**Rationale**: ADR 0004 makes pgvector a secondary index, never a source of truth. That claim is
only meaningful if the product works without it — otherwise the index is the source of truth and
nobody noticed. Most real knowledge queries in this system are structural anyway ("what should
component X do"), which the vector path answers worse than a join.

## R-07 · Constraint conflicts are counted, never ranked

**Decision**: `ResolveConstraint(name, scope)` counts authoritative definitions. Zero returns
`NOT_FOUND`; one returns the typed value with its document, version and provenance; more than one
returns `CONSTRAINT_CONFLICT` naming every definition. There is no unique index forcing a single
row, and no ranking step inside the resolver.

**Rationale**: FR-015 requires a conflict to be *reported*, not resolved by ranking. A unique index
would prevent the conflict from being representable, which sounds attractive and means the second
document silently fails to ingest. Ranking would pick a winner, and a policy predicate would then
evaluate `max_payment_retries` against a value chosen by a tie-break — a deterministic wrong answer,
which is worse than an error.

"Authoritative" means resolving through an `anchor_grant` (R-01): a `machine_generated`, unadopted
constraint is citable but is not an authoritative value (FR-008, FR-014). A conflict between an
adopted value and a machine-generated one is therefore not a conflict at all — only one is
authoritative.

## R-08 · The repository markdown format carries prose and structure together

**Decision**: one markdown file per feature, under a configured path. YAML front matter holds the
machine-readable part; the body is prose for humans.

```yaml
---
feature: checkout
component: checkout-api          # resolved against 004
expected_behaviors:
  - id: checkout-002
    description: duplicate checkout cannot create duplicate order
constraints:
  max_payment_retries: { type: int, value: 3 }
  inventory_reservation_timeout: { type: duration, value: 15s }
---
```

The front matter is parsed into `expected_behavior_version` and `knowledge_constraint` rows; the body
becomes `document_section` rows. `id` is the stable identifier across edits — a renamed heading does
not create a new expectation.

**Rationale**: the structured block and the prose have to travel together or they drift apart within
a release, and the customer edits one file in one review. Parsing front matter rather than prose is
what keeps FR-014's "no model in the path" true: the constraint value is read, never interpreted.

A malformed front-matter block fails the file's ingest with a named error and leaves the previous
version in place — a partially parsed expectation is worse than none.

**Extension for 013** (regression scenarios): each `expected_behaviors` entry MAY carry `subject`
(`endpoint` · `page` · `flow` with its 004 reference), `given`, `when`, `then` and `priority`. They are
parsed and stored with the version, never interpreted, and a document without them parses as before.
Constraints remain the only thing a test asserts (013 R-01).

## R-09 · Freshness never touches anchor state

**Decision**: `source_modified_at`, `last_synced_at` and `last_verified_at` are recorded per document
and exposed on every retrieval result (FR-018). No scheduled job, no freshness threshold and no
staleness window writes to `anchor_grant`. The only writers are the adoption transaction and a human
revocation command.

**Rationale**: the spec is explicit that adoption does not expire, and the reason is worth keeping
in front of whoever implements the staleness job: an anchor that expires on a timer makes a
verification result depend on when it ran. The same patch verified on Monday and re-verified on
Friday would produce different verdicts with no change to code, tests or expectations — and the
Friday run would be the one that silently fell back to "the tests pass".

This is enforceable rather than documentary: a check asserts every `anchor_grant` write carries a
human `actor_ref`, and `revoked_at` is only ever set by the revocation command.

Stale adopted expectations are surfaced instead — through freshness on the retrieval result, and
through drift (FR-016) when the document disagrees with code or observation.

## R-09a · Paths are merged by tier and path order, never by a fused score

**Decision**: lexical and semantic retrieval each rank within themselves. Results are merged by
trust tier first, then by **path order** — lexical before semantic — then by each path's own rank,
then by document identifier. There is no arithmetic combining a `ts_rank` with a vector distance.

**Rationale**: the two numbers have no common unit, and any weighting that makes them comparable is
invented rather than derived — it would look principled while being arbitrary, and it would move
every time either path's implementation changed. Lexical goes first because an exact term match is
evidence of relevance in a way a nearby embedding is not. Determinism is preserved (SC-005) because
every tiebreak is a total order.

**Alternatives**: reciprocal rank fusion (defensible, but it makes the ordering depend on a constant
nobody can justify and obscures which path found a result); normalising both to 0..1 (normalising
across incomparable scales is the same invention with more steps).

## R-10 · Near-duplicate detection without a model

**Decision**: exact duplicates by normalised content hash; near duplicates by `pg_trgm` similarity
over normalised section text above a per-tenant threshold. Groups are stored in `duplicate_group`
with one canonical document; the others stay retrievable and linked (FR-020).

**Rationale**: duplicate grouping affects what a human sees and what a citation resolves to, so it
must be reproducible and must not depend on the vector index SC-004 says is optional. `pg_trgm` is
core Postgres contrib, deterministic, and needs no model call. The threshold is per-tenant
configuration because corpus style varies more than any constant would survive.

`pg_trgm` and `tsvector` are Postgres facilities rather than new services, but the extension list is
a dependency surface: ADR 0004 gets a one-line amendment naming `vector`, `pg_trgm` and the built-in
full-text configuration, so 012 FR-006's dependency gate has something to check against.

**Alternatives**: embedding-similarity clustering (non-deterministic across index rebuilds, and
unavailable with the vector index dropped); MinHash in application code (a correct answer to a
problem Postgres already solves).

## R-10a · Observed reality enters through a port, not as a document

**Decision** (now normative as FR-029, C-21): the `current_behavior` question type ranks **evidence**
above documents, and evidence does not live in `knowledge_document`. Retrieval calls an
`ObservedBehaviorQuery` port into 001/003 evidence and interleaves the result above every document
tier. `knowledge_document` gains no `source_class` member for observation, because a document is a
claim and an observation is not.

A result is therefore a **discriminated union on `kind`**: `document` carries
`documentVersionId` and `sectionId`; `observation` carries `evidenceId` and neither of those. The
single flat result shape that preceded this *required* a document version and a section, so the top
trust tier of `current_behavior` had no expressible result and the tier was unimplementable — the
guarantee existed only in this entry's prose. Union members rather than nullable fields, because a
nullable `documentVersionId` is a field every consumer must remember to check.

**Rationale**: the trust hierarchy is the reason this feature exists, and its top tier for "what does
the system do" is observed reality. Modelling observations as documents would let them rot, be
edited, and acquire provenance they do not have. A port keeps them as what they are.

**Alternatives**: ingesting observations as documents (they would then need freshness, versioning and
adoption, none of which apply to a fact that was observed).

## R-11 · Document content is data, and here is where it is neutralised

**Decision**: document text enters the system only as `document_section.content` and leaves it only
as a retrieval result marked untrusted. It is never a ranking input — ranking reads source class,
provenance, freshness and lexical/vector scores, all metadata. It is never a constraint value —
values come from typed front matter, not from prose. It is never a predicate input, a tool argument
or an autonomy input (FR-026).

**Rationale**: a knowledge corpus is the highest-value prompt-injection surface in this product,
because a wiki page is writable by more people than a repository and is read by an agent that can
open merge requests. Stating "content is data" is not a mechanism; the mechanism is that every path
from content to a decision is closed by the shape of the data, and the one path that looks open —
a document declaring a constraint — is typed front matter parsed by a schema, not prose read by a
model.

A document containing instruction-shaped text is stored and returned normally, and a quickstart
scenario asserts 0 differences in ranking, predicates and tool calls when it is present.

## R-11a · `last_verified_at` is written only by the drift check, and only on agreement

**Decision**: `last_verified_at` is set when the drift check compares a document against code or
observation and finds **agreement**. Nothing else writes it. Absence means "never verified", which is
displayed as such rather than as a null date.

**Rationale**: a field that reads "last verified against reality" and is written by anything other
than a verification against reality is a lie with a timestamp. Editing a document does not verify it;
adopting an expectation does not verify it.

**Alternatives**: touching it on edit (an author asserting their own correctness); touching it on
retrieval (confuses "was read" with "was checked").

## R-12 · Seeding is idempotent by extraction key

**Decision**: each seeded draft records `extraction_key` — a digest of (source artifact identity,
extraction rule id, normalised extracted subject) — unique per tenant and feature. A re-run upserts
by that key: existing drafts are left alone, adopted entries are never touched (FR-023).

**Rationale**: seeding runs repeatedly during onboarding and again whenever OpenAPI or the e2e suite
changes. Without a stable key, the second run doubles the review queue, and a reviewer facing six
hundred drafts instead of three hundred stops reviewing — which is the S0-5 failure, measured as a
number rather than as a bug.

The key excludes the extraction *output* text: a reworded description from the same rule and
artifact is the same draft, not a new one.

## R-13 · A budget-constrained retrieval is marked incomplete

**Decision**: when the per-issue or per-tenant budget (002 FR-011) cuts a retrieval short, the result
carries `complete: false` and names the unconsulted sources, following the declared degradation
order (002 FR-012). The structural path is consulted first and the vector path last, so degradation
removes recall before it removes identity matches.

**Rationale**: a silently narrowed retrieval is indistinguishable from a corpus that has no answer,
and the consumer downstream is a diagnosis agent that will conclude from what it received. Naming
the unconsulted sources is what lets 006 record `INSUFFICIENT_CONTEXT` (006 FR-013) honestly rather
than producing a confident answer from half a corpus.

## R-14 · Knowledge drift raises an `Issue`, the same way graph drift does

**Decision**: a `knowledge_drift_finding` holds both sides with their evidence references and raises
an `Issue` of kind `knowledge_drift` (001 FR-001), terminating at human adjudication (001 FR-001a).
No document is edited and no change proposal is opened from it (FR-017).

**Rationale**: 004 raises graph drift identically, so a customer has one queue of "the model of your
system disagrees with your system" rather than two. Detection is deterministic: an adopted constraint
whose value contradicts an observed value or a code constant, an expectation naming a component or
endpoint absent from the confirmed graph (004), a runbook step naming a deployment target that no
longer exists.

An adopted expectation referencing a component that vanished raises drift against the expectation and
never deletes it — retiring a feature is a human's decision (spec edge case), and a deleted anchor
would silently weaken every verification that referenced it.

## R-15 · One declared embedding model in v1, dimension fixed in the column

**Decision**: v1 declares exactly one embedding model. `section_embedding.embedding` is
`vector(1024)` and `model_ref` records the model that produced each row. A second model is a
migration plus a backfill, not a configuration change. Embedding generation is charged to the
tenant's budget as a model call like any other (012 FR-036), under `purpose = embedding`.

**Rationale**: a `vector(N)` column has one width, so "configurable dimension" is not a thing that
exists — pretending otherwise defers a decision that the first migration forces anyway. Recording
`model_ref` per row is what makes the eventual second model a backfill rather than a reset.

**Alternatives**: a nullable-width JSON column (loses the index, which is the only reason pgvector is
here); one table per model (the retrieval path then has to know which tables exist).

## R-16 · The in-product adoption endpoint is not in v1

**Decision**: `knowledge:adopt` as an in-product action is **not implemented in v1**. Adoption
happens only through a merge-request approval on the repository (C-06). The capability exists in the
permission model so that the later path needs no new capability, but no endpoint serves it.

**Rationale**: C-06 makes repository markdown the only text adapter, and the reason it was chosen is
that code review *is* the adoption gate. An in-product adopt button would be a second gate with
weaker properties — no diff, no reviewer identity from an existing system, no history — and it would
become the path everyone uses because it is easier.

**Alternatives**: shipping both (the weaker gate wins by convenience, which defeats the choice).

## R-17 · Healer's own identity comes from configuration, and self-adoption is rejected on it

**Decision**: Healer's service identity on the repository host is a configuration value in
`packages/shared/config` (012 FR-042). The adoption check compares the approving identity against it
and rejects a match. The GitLab credential separately holds no approval permission, so the check is
the second of two mechanisms rather than the only one.

**Rationale**: the credential scope is the real defence, but a credential is rotated by people under
time pressure and scopes get widened. The identity check survives that mistake, and constitution II
is void if Healer can adopt its own anchor.

## Unresolved

None.
