# Feature Specification: Knowledge sources, provenance and expected behaviour

**Feature Branch**: `005-knowledge-and-expected-behavior`

**Created**: 2026-09-23

**Status**: Draft

**Input**: One retrieval surface over every place a customer's knowledge lives, ranked by a trust hierarchy that inverts depending on whether the question is "what does the system do" or "what should it do" — plus `ExpectedBehavior` as a first-class, human-adopted entity, because only an anchor a human owns can verify a machine's work.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Only an adopted expectation is an anchor (Priority: P1)

Healer reads OpenAPI descriptions, end-to-end test names, acceptance criteria and the existing wiki
and proposes three hundred expectations for a feature. Every one is a draft. A named engineer reads
them, edits some, adopts most and discards the rest. From that moment the adopted ones — and only
those — may be used to verify a fix. The drafts Healer wrote and nobody adopted can be cited, but
can never anchor a verification.

**Why this priority**: Principle II. If Healer can write its own verification anchors, every gate
reports PASS against Healer's own earlier conclusion and the independence argument collapses
completely. This is the single requirement that makes the rest of the product's safety claim true.

**Independent Test**: attempt to use a machine-generated, unadopted `ExpectedBehavior` as a
verification anchor → refused; adopt it with a human actor → permitted, with the adoption record
naming the human.

**Acceptance Scenarios**:

1. **Given** a machine-generated `ExpectedBehavior` in state `draft`, **When** a verification step
   requests it as an anchor, **Then** the request is refused and the refusal is recorded.
2. **Given** the same entry, **When** adoption is attempted by an agent or automation credential,
   **Then** it is refused — adoption is a human-only action.
3. **Given** a human adopts an entry, **When** the adoption is recorded, **Then** it names the
   actor, the timestamp, the content version adopted and the source artifacts it was seeded from.
4. **Given** an adopted entry is edited afterwards, **When** the edit is saved, **Then** a new
   version is created and its anchor eligibility follows the adopted version, not the edit, until
   the edit is itself adopted.
5. **Given** an adopted entry is retired, **When** a verification step requests it, **Then** it is
   refused as an anchor while remaining readable as history.

---

### User Story 2 - The stale wiki cannot cause a misdiagnosis (Priority: P1)

The wiki says the retry limit is five. The code says three. Production shows three. An engineer
asks Healer "how many retries does checkout do?" and gets three, sourced from observed behaviour
and code. They ask "how many should it do?" and get the adopted expectation, with the wiki cited
below it. The same corpus, two questions, two different orderings.

**Why this priority**: every company's wiki is wrong, and a retrieval layer that treats documents
as uniformly authoritative will confidently answer a current-behaviour question from a
three-year-old page. The inversion is what makes a stale wiki safe to keep in the corpus.

**Independent Test**: seed a corpus where wiki, code and observation disagree → the
current-behaviour query ranks observation first and wiki last; the intended-behaviour query ranks
the adopted expectation first and observation last.

**Acceptance Scenarios**:

1. **Given** a query declared as current-behaviour, **When** results are ranked, **Then** the order
   is observed reality, then code and tests, then verified incidents, then human-authored documents.
2. **Given** a query declared as intended-behaviour, **When** results are ranked, **Then** the order
   is adopted `ExpectedBehavior`, then human-written acceptance tests, then code, then observation.
3. **Given** a query with no declared question type, **When** it is submitted, **Then** it is
   refused rather than answered under a default ranking.
4. **Given** identical query and corpus, **When** the query is repeated, **Then** the ranking is
   identical and each result carries the rule and trust tier that placed it.

---

### User Story 3 - One search over every source, and the original is always recoverable (Priority: P1)

Git history, the wiki, past incidents, merged pull requests, runbooks, postmortems, tickets and
OpenAPI descriptions answer one query. Every result names its source system, its document, the
exact span that matched and a link back to the original — which still opens, in the system it came
from.

**Why this priority**: knowledge that cannot be traced back to its origin is indistinguishable from
a model's recollection, and a citation nobody can open is not a citation. The recoverable original
is what makes a knowledge citation usable as evidence at all.

**Independent Test**: run one query → results arrive from at least four distinct source types, each
resolving to a retrievable original document and version, and the query returns results with the
vector index disabled.

**Acceptance Scenarios**:

1. **Given** a query, **When** results return, **Then** each carries source system, document
   identity, document version, matched span and a resolvable reference to the original.
2. **Given** the vector index is unavailable or disabled, **When** the same query runs, **Then**
   it still returns results from the structural and lexical paths.
3. **Given** an original document is deleted at its source, **When** a stored citation to it is
   read, **Then** it resolves to the captured version and is marked detached (001 FR-010), never a
   broken link.
4. **Given** a retrieval result used in a conclusion, **When** it is persisted, **Then** it exists
   as an `Evidence` record of document-excerpt type (001 FR-007) with its trust tier recorded.

---

### User Story 4 - Cold start is a flow, not an assumption (Priority: P2)

A new customer has no structured product documentation, because almost nobody does. Onboarding does
not ask them to write any. It reads what already exists — OpenAPI, end-to-end test names, ticket
acceptance criteria, whatever wiki there is — proposes expectations feature by feature, and asks a
human to adopt them in a session measured in hours, not weeks.

**Why this priority**: the product graph and adopted expectations are what everything distinctive
depends on, and a customer who must author them from nothing never starts. Stage 0 (S0-5) exists to
measure whether this flow is survivable; if it is not, product verification never happens in
practice and the loop degrades to "the tests pass".

**Independent Test**: run seeding for one design-partner feature from real artifacts → drafts are
produced with each one's source artifact attributed, and the counts proposed, adopted unchanged,
edited and discarded are recorded.

**Acceptance Scenarios**:

1. **Given** connected sources, **When** seeding runs for a feature, **Then** each produced draft
   names the artifact it was derived from and the extraction rule used.
2. **Given** a seeding run is repeated, **When** it executes, **Then** it does not duplicate
   existing drafts and does not touch adopted entries.
3. **Given** a seeding session, **When** it completes, **Then** proposed, adopted-unchanged, edited
   and discarded counts and elapsed review time are recorded as onboarding metrics.
4. **Given** a customer with no wiki and no acceptance criteria, **When** seeding runs, **Then** it
   still produces drafts from OpenAPI and test names, and records which input classes were absent.

---

### User Story 5 - Code and wiki disagreeing is a human's decision (Priority: P2)

A runbook describes a failover procedure the code no longer implements. Healer raises
`KnowledgeDrift`: here is the document, here is the code, here is what production shows. It does not
edit the runbook and it does not open a pull request against the code. Only a person knows which
side is wrong.

**Why this priority**: auto-resolving drift in either direction is how a knowledge base becomes a
record of a model's opinions. Over a year that is failure mode 7 — the system quoting itself with
compounding confidence.

**Independent Test**: seed a document contradicting observed behaviour → a drift finding exists,
routed to a human, with neither the document nor the code modified.

**Acceptance Scenarios**:

1. **Given** a document contradicted by code or observation, **When** drift detection runs, **Then**
   a finding is raised carrying both sides with their evidence references.
2. **Given** a drift finding, **When** it exists, **Then** no document is edited and no code change
   is proposed automatically from it.
3. **Given** a human resolves the drift, **When** the resolution is recorded, **Then** the actor,
   the direction of resolution and the resulting document version are audited (001 FR-012).

---

### User Story 6 - Structured constraints a predicate can check (Priority: P3)

Alongside the prose that humans read, a feature carries machine-readable constraints —
`max_payment_retries: 3`, `inventory_reservation_timeout: 15s`. When a patch changes retry
behaviour, that stops being a judgement a model makes about a paragraph and becomes a comparison a
deterministic predicate performs.

**Why this priority**: Principle IV requires gates on structural, checkable facts. Prose retrieval
gives plausible paragraphs; a named typed value gives an answer a policy rule can evaluate without
a model in the path.

**Independent Test**: define constraints on a feature → a policy predicate reads each by name and
type and evaluates it with no model call, and a constraint without a name and type cannot be saved.

**Acceptance Scenarios**:

1. **Given** a feature with structured constraints, **When** a predicate requests one by name,
   **Then** it receives a typed value with its source document, version and provenance.
2. **Given** a constraint whose provenance is machine-generated and unadopted, **When** a predicate
   requests it as an authoritative value, **Then** it is refused for the same reason an unadopted
   expectation cannot anchor.
3. **Given** two documents defining the same constraint differently, **When** it is requested,
   **Then** the conflict is reported rather than silently resolved by ranking.

---

### Edge Cases

- A document is enormous (a 400-page exported handbook) → it is indexed as bounded, addressable
  sections; retrieval returns the matching section with its position, never the whole document.
- The same content exists in three places (wiki page, README, runbook) → near-duplicates are
  grouped with one canonical document; the others remain retrievable and linked, so a citation to
  any of them resolves.
- A source's content changes between retrieval and use → citations pin a document version, and a
  consumer holding a pinned citation to a changed version is told it is stale rather than served
  new content under the old reference.
- Knowledge and evidence disagree about the past → evidence wins for what happened; knowledge is
  retained as a claim about what was intended.
- A document contains instruction-shaped text aimed at an agent → it is stored and returned as
  untrusted data; it reaches no predicate and authorises nothing.
- A `KnowledgeSource` is disconnected by the customer → its documents are marked unavailable and
  citations to them detach (001 FR-010); nothing is deleted on disconnection alone.
- An adopted expectation refers to a component that no longer exists in the graph (004) → drift is
  raised against the expectation rather than deleting it; a retired feature is a human's call.
- A human adopts an expectation that is wrong → it is an anchor anyway, which is correct: the human
  owns it, and the audit records who adopted it and when. Adoption is revocable.
- Two tenants operate identical open-source repositories → documents, embeddings and retrieval
  remain strictly tenant-scoped; identical content is never shared across tenants.
- Retrieval budget is exhausted mid-query (002 FR-011) → fewer sources are consulted and the result
  is marked incomplete with the unconsulted sources named, never silently narrowed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST model `KnowledgeSource` as an abstraction over at minimum: Git history,
  wiki pages, incident history, pull requests, runbooks, postmortems, tickets and OpenAPI
  descriptions, each with its connection state, sync state and last successful sync time.
- **FR-002**: System MUST provide one retrieval surface across all connected sources, returning for
  every result the source system, document identity, document version, matched span, provenance,
  trust tier and a resolvable reference to the original.
- **FR-003**: Retrieval MUST function without any model call and without the vector index. Vector
  search MUST be a secondary index that improves recall and MUST NOT be the only path to a document
  or a source of truth (D-05).
- **FR-004**: Every retrieval request MUST declare its question type — `current_behavior` or
  `intended_behavior`. A request without a declared question type MUST be refused.
- **FR-005**: Ranking for `current_behavior` MUST order observed reality above code and tests, above
  verified incidents, above human-authored documents. Ranking for `intended_behavior` MUST order
  adopted `ExpectedBehavior` above human-written acceptance tests, above code, above observed
  reality.
- **FR-006**: Ranking MUST be deterministic and explainable: identical query and corpus produce
  identical ordering, and every result carries the trust tier and rule that placed it.
- **FR-007**: Every knowledge document MUST carry a provenance value of `human_authored`,
  `machine_generated` or `machine_generated_adopted`, and provenance MUST be immutable except
  through a recorded adoption.
- **FR-008**: A `machine_generated` document MUST be citable with reduced retrieval weight and MUST
  NOT be usable as a verification anchor or as an authoritative constraint value.
- **FR-009**: System MUST model `ExpectedBehavior` as a first-class entity with states `draft`,
  `adopted`, `superseded` and `retired`, linked to a feature and component (004), carrying its
  description, its structured constraints and its seeding provenance.
- **FR-010**: An `ExpectedBehavior` MUST be usable as a verification anchor **only through an
  `anchor_grant`**, which exists only for an adopted expectation. A consumer MUST reference the grant
  identifier and MUST NOT decide eligibility by reading `expected_behavior.state` (C-12). An
  unadopted expectation is therefore not rejected at the anchor check — it has no grant, so it is
  **unnameable**, and there is no predicate to forget. A request naming a revoked or absent grant MUST
  be refused and the refusal recorded.
- **FR-011**: Adoption MUST be performable only by a human actor, MUST record actor, timestamp and
  the exact content version adopted, and MUST be audited (001 FR-012). An agent or automation
  credential MUST NOT be able to adopt.
- **FR-012**: Editing an adopted entry MUST create a new version whose anchor eligibility requires
  its own adoption. The previously adopted version MUST remain the anchor until then.
- **FR-013**: Adoption MUST be revocable, and revocation MUST take effect immediately on subsequent
  anchor requests while leaving completed verifications and their audit records intact.
- **FR-014**: System MUST store structured, machine-readable constraints alongside prose, each with
  a name, a type and a value, retrievable by name by a deterministic predicate with no model in the
  path (002 FR-003).
- **FR-015**: Conflicting definitions of the same constraint across documents MUST be reported as a
  conflict rather than resolved by ranking, and the two mechanisms that report it apply on two
  different paths:
  - **A resolution request** (FR-014) MUST fail with `CONSTRAINT_CONFLICT` naming every authoritative
    definition, and MUST NOT raise an issue. The caller is a deterministic predicate waiting for a
    value; an error is the only honest answer, and one issue per evaluation would be noise.
  - **Corpus drift detection** (FR-016) MUST raise exactly one `constraint_value_conflict` finding per
    conflicting set, routed to a human (FR-017), so the conflict is *fixed* rather than merely refused
    on every request. The finding MUST be keyed on the conflicting set so repeated detection does not
    duplicate it, and MUST close when the conflict does.

  The two describe the same underlying state on the synchronous and the asynchronous path. Neither
  suppresses the other, and neither may pick a winner.
- **FR-016**: System MUST detect disagreement between a document and code or observed reality and
  MUST raise a drift finding routed to a human.
- **FR-017**: A knowledge drift finding MUST NOT cause an automatic edit to a document and MUST NOT
  cause an automatic change proposal against code. Resolution MUST be a recorded human action.
- **FR-018**: Every document MUST carry freshness state — source last modified, last synced, last
  verified against reality — and every retrieval result MUST expose it.
- **FR-019**: Documents MUST be versioned, and a citation MUST pin a version. A consumer holding a
  citation to a superseded version MUST be told it is stale rather than silently served the current
  content.
- **FR-020**: System MUST detect near-duplicate documents, group them, designate one canonical
  document and keep the others retrievable and linked.
- **FR-021**: The write path MUST produce drafts only, each with a named human owner. The system
  MUST NOT publish to a customer knowledge system automatically (D-23).
- **FR-022**: System MUST provide a seeding flow that derives `ExpectedBehavior` drafts from
  existing artifacts — OpenAPI descriptions, end-to-end test names, ticket acceptance criteria and
  existing documents — attributing each draft to the artifact and extraction rule that produced it
  (D-20).
- **FR-023**: Seeding MUST be repeatable and incremental: a re-run MUST NOT duplicate existing
  drafts and MUST NOT modify adopted entries.
- **FR-024**: System MUST record per seeding session the counts proposed, adopted unchanged, edited
  and discarded, the input classes present and absent, and the elapsed review time, queryable as
  onboarding metrics (S0-5).
- **FR-025**: A retrieval result that supports a persisted conclusion MUST be recorded as an
  `Evidence` record of document-excerpt type (001 FR-007), emitted by the retrieving step (001
  FR-008), carrying its trust tier and freshness at time of use.
- **FR-026**: All document content MUST be treated as data. It MUST NOT be able to influence any
  policy predicate (002 FR-003), any tool invocation, any autonomy grant or any retrieval ranking
  rule.
- **FR-027**: Every document, version, embedding, `ExpectedBehavior`, constraint and drift finding
  MUST carry `tenantId`, and every retrieval MUST apply `tenantId` from the authenticated context as
  a mandatory query-layer parameter (001 FR-015). Retrieval across tenants followed by filtering
  MUST NOT be possible by construction, and a request for another tenant's document MUST return
  not-found, never forbidden.
- **FR-028**: Knowledge retrieval MUST respect per-issue and per-tenant budgets and the declared
  degradation order (002 FR-011, 002 FR-012). A budget-constrained retrieval MUST be marked
  incomplete with the unconsulted sources named.
- **FR-029**: A retrieval result MUST be a **discriminated union** over
  `kind: 'document' | 'observation'` (C-21). A `document` result carries `documentVersionId` and
  `sectionId` as FR-002 requires. An **`observation` result carries `evidenceId` and MUST NOT carry a
  document version or a section**, because an observation is not a claim someone authored: it has no
  version to pin, no freshness to sync and no adoption to acquire. Observations MUST be supplied by an
  `ObservedBehaviorQuery` port into the `Evidence` records of 001 and 003, MUST NOT be ingested as
  knowledge documents, and MUST be rankable in the `current_behavior` top tier (FR-005) — without this
  the highest-trust tier of "what does the system actually do" is unrepresentable. Both members MUST
  carry the trust tier, the ranking rule and the rule-set version (FR-006), and `observation` results
  MUST NOT carry a provenance value from FR-007's document vocabulary.

### Key Entities

- **KnowledgeSource**: a connected system holding documents. Type, connection state, sync state,
  last successful sync, the document classes it yields.
- **KnowledgeDocument**: an addressable unit of knowledge. Tenant, source, external identity, title,
  sections, provenance, freshness state, canonical or duplicate-of relationship, current version.
- **DocumentVersion**: an immutable content revision with its captured content, hash and observed
  source modification time; the unit a citation pins.
- **ExpectedBehavior**: what the system *should* do. Tenant, feature and component references,
  description, structured constraints, state, seeding provenance, adopted version, adoption record.
- **AdoptionRecord**: the human act that makes an entry an anchor — actor, timestamp, adopted
  version, the source artifacts it was seeded from, and any later revocation.
- **Constraint**: a named, typed, machine-readable value attached to a feature or expectation, with
  its defining document, version and provenance.
- **RetrievalQuery**: question type, scope, filters and budget — the record that makes a ranking
  reproducible.
- **RetrievalResult**: a discriminated union on `kind` (FR-029, C-21). `kind: 'document'` — document
  version, matched span, trust tier, provenance, freshness and the ranking rule that placed it.
  `kind: 'observation'` — an `Evidence` reference (`evidenceId`), its observed time, trust tier and
  ranking rule, with no document version, no section and no document provenance.
- **ObservedBehaviorQuery**: the port through which observations enter retrieval — a scoped read over
  001/003 `Evidence`, returning observation results. It is the only route for the `current_behavior`
  top tier, and it never writes a `KnowledgeDocument`.
- **KnowledgeDriftFinding**: a recorded disagreement between a document and code or observation,
  with both sides, evidence references, state and human resolution.
- **SeedingSession**: one onboarding run — feature scope, input classes used, drafts produced,
  outcomes and elapsed review time.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of verification anchor references resolve to an `anchor_grant` whose
  `adoption_record.actor_type` is `human`, and 0 resolve to anything else — verified as a continuous
  join over anchor usage, `anchor_grant` and `adoption_record`. The measurement is deliberately **not**
  stated over `expected_behavior.state`: the grant is the only thing that can name an anchor (R-01,
  C-12), no task maintains `state` as an anchor predicate, and a criterion written over an unmaintained
  column would pass while proving nothing.
- **SC-002**: 0 adoptions are recorded with a non-human actor, verified by an automated check over
  adoption records that fails the build if such a path exists.
- **SC-003**: 100% of retrieval results resolve to a retrievable original document and pinned
  version, or to a recorded `detached` state.
- **SC-004**: With the vector index disabled, retrieval returns results for 100% of queries that
  have a lexical or structural match, demonstrating it is not a source of truth.
- **SC-005**: Identical query and corpus produce identical ranking in 100% of repeated runs, and
  100% of results expose the trust tier and rule that placed them.
- **SC-006**: In a seeded corpus where wiki, code and observation disagree, 100% of
  `current_behavior` queries rank observation above the wiki and 100% of `intended_behavior` queries
  rank the adopted expectation above observation.
- **SC-007**: 0 documents are published to a customer system by Healer; 100% of generated documents
  exist as drafts with a named human owner.
- **SC-008**: 0 knowledge drift findings are resolved without a recorded human action, and 0
  documents are edited automatically as a result of one.
- **SC-009**: Seeding for one design-partner feature produces drafts from every available input
  class, with proposed, adopted, edited and discarded counts and total review time recorded — the
  onboarding baseline S0-5 exists to measure. The counts are reported **per input class** — OpenAPI,
  end-to-end test names, acceptance criteria, wiki — because which class a human actually adopts from is
  what says which seeding adapter to build next, and it is the same measurement the per-source-class
  freshness windows are waiting on.
- **SC-009a**: For the seeded feature, the share of that feature's historical incidents (S0-1) that would
  have had an adopted expectation covering them is measured and reported. Adoption volume is not the
  criterion — three hundred adopted expectations for a feature nobody breaks change nothing. This share is
  the quantity that predicts how often 006 will record `NO_EXPECTATION` and 008's automated path will
  therefore refuse, which is to say how often the fix loop fires at all.
- **SC-010**: 100% of structured constraints are readable by name and type by a deterministic
  predicate with 0 model calls in that path.
- **SC-011**: 0 cross-tenant documents, embeddings, constraints or expectations appear in any
  retrieval result, across an isolation matrix covering every source type and every retrieval path.

## Assumptions

- This specification owns knowledge sources, retrieval, ranking, provenance, versioning, freshness,
  duplicate detection, `ExpectedBehavior`, adoption, structured constraints and knowledge drift. It
  does **not** own the architecture graph or feature-to-endpoint links (004), answer generation and
  grounding (009), context collection and the boundary contract (003), the `Evidence` model or audit
  trail (001), policy and budgets (002), or wiki generation from resolved incidents, which is
  post-v1.
- A knowledge drift finding is raised as an `Issue` of kind `knowledge_drift` (001 FR-001, FR-001a),
  which terminates at human adjudication; 004 uses the same kind for graph drift.
- The v1 source set follows the design partner's reality (D-04, S0-4): Git history, GitLab merge
  requests and issues, OpenAPI descriptions, end-to-end test names and whatever wiki exists.
  **No hosted-wiki adapter ships in v1.** The `KnowledgeSource` abstraction exists from day one, but
  the only text-document adapter implemented is repository markdown. Beyond costing no integration
  work, it is the stronger source: git history supplies freshness and authorship for free, and
  adoption of an `ExpectedBehavior` passes through code review — which is the human adoption gate the
  anchor requires. A hosted wiki provides none of the three. Confluence, Notion and the rest follow
  the first customer who needs one.
- Adoption does not expire. A stale adopted expectation is surfaced through freshness and drift
  (FR-018, FR-016) and revoked by a human (FR-013), rather than silently losing anchor status on a
  timer — an anchor that expires on its own would make a verification result depend on the clock.
- Structured constraints are authored or adopted by humans in the same act as the expectation that
  carries them; this specification does not infer constraint values from code as authoritative.
- Storage follows the constitution's stack: PostgreSQL as source of truth with pgvector as the
  secondary retrieval index (D-05). No separate vector store and no graph database. **In v1 the
  vector index holds nothing derived from a customer document** (C-36, ADR 0010): an embedding is a
  model call over content that does not cross, so retrieval over customer documents uses the lexical
  and structured paths FR-003 already requires.
- Human-written acceptance tests are recognised through the test sources connected by 003 and 004
  adapters; this specification ranks them and does not execute them.
- Freshness windows, duplicate-similarity thresholds, retrieval result limits and the ranking
  weights within each trust tier are per-tenant configuration tuned from the design partner's
  corpus, not constants.
