# Contract: retrieval, anchors and the knowledge document format

Three surfaces: what 006, 008 and 009 call in-process, what makes an anchor an anchor, and what a
customer's repository actually holds.

## 1 · Retrieval requires a declared question type

Internal callers use typed in-process interfaces, not MCP (ADR 0005, D-06).

```ts
type QuestionType = 'current_behavior' | 'intended_behavior';   // no default, no third value

interface RetrievalRequest {
  readonly questionType: QuestionType;   // required — there is no rank(query) entry point (R-03)
  readonly terms?: string;
  readonly scope?: { componentNodeId?: NodeId; featureNodeId?: NodeId; documentClass?: string[] };
  readonly limit: number;
  readonly budgetRef?: BudgetRef;        // 002 FR-011
}

/** Every result carries the ranking facts; the rest depends on what kind of thing it is. */
interface RetrievalResultBase {
  readonly tier: number;
  readonly ruleId: string;
  readonly ruleSetVersion: number;       // the ranking is reproducible (FR-006, SC-005)
  readonly content: UntrustedText;       // data, never instructions (FR-026, R-11)
}

interface DocumentResult extends RetrievalResultBase {
  readonly kind: 'document';
  readonly documentVersionId: Uuid;
  readonly sectionId: Uuid;
  readonly matchedSpan: [number, number];
  readonly provenance: 'human_authored' | 'machine_generated' | 'machine_generated_adopted';
  readonly freshness: { sourceModifiedAt?: string; lastSyncedAt?: string; lastVerifiedAt?: string };
  readonly originRef: string;            // resolvable in the source system (FR-002)
  readonly detached: boolean;            // original deleted at source (001 FR-010)
}

/** An observation is not a claim someone authored: no version to pin, no freshness to sync,
 *  no adoption to acquire, no document provenance. It is an Evidence reference (C-21, R-10a). */
interface ObservationResult extends RetrievalResultBase {
  readonly kind: 'observation';
  readonly evidenceId: Uuid;             // 001/003 Evidence — the ONLY identity it has
  readonly evidenceType: string;         // error_signature, trace_shape, metric_delta, test_result, …
  readonly observedAt: string;
  readonly sourceSystem: string;
}

type RetrievalResult = DocumentResult | ObservationResult;   // discriminated on `kind` (FR-029)

interface RetrievalResponse {
  readonly results: ReadonlyArray<RetrievalResult>;
  readonly complete: boolean;            // false when a budget cut it short (FR-028, R-13)
  readonly unconsultedSources: ReadonlyArray<string>;
  readonly pathsUsed: ReadonlyArray<'structural' | 'lexical' | 'vector' | 'observation'>;
}

/** The fourth path. Observations do not live in knowledge_document, so they are not a document
 *  class — they are read through a port into 001/003 evidence and interleaved by tier (C-21). */
interface ObservedBehaviorQuery {
  observe(scope: {
    componentNodeId?: NodeId;
    issueId?: Uuid;
    window?: { from: string; to: string };
    limit: number;
  }): Promise<ReadonlyArray<ObservationResult>>;
}
```

`documentVersionId` and `sectionId` live on `DocumentResult` and nowhere else, which is what makes an
observation representable at all: the previous single shape **required** both, so the top trust tier of
`current_behavior` had no expressible result and the tier was unimplementable. A consumer switches on
`kind`; there is no field that is sometimes a document version and sometimes an evidence id.

A request without `questionType` fails schema validation before the query layer. This is not a
runtime check with a helpful message — the ranking functions are `rankCurrentBehavior` and
`rankIntendedBehavior`, dispatched from the discriminator, and there is no function that ranks
without one (FR-004, R-03).

### Ranking

```text
ORDER BY tier ASC, score DESC, capturedAt DESC, documentId ASC
```

The last key makes the order total: without it two results with equal tier, score and capture time
come back in plan order, and SC-005 fails intermittently (R-04).

| Tier | `current_behavior` | `intended_behavior` |
|------|--------------------|---------------------|
| 1 | observed reality — traces, metrics, logs, test runs | adopted `ExpectedBehavior` |
| 2 | code and tests | human-written acceptance tests |
| 3 | verified incidents | code |
| 4 | human-authored documents | observed reality |
| 5 | machine-generated, unadopted documents | machine-generated, unadopted documents |

The rows reading "observed reality" — tier 1 for `current_behavior`, tier 4 for `intended_behavior` —
are `ObservationResult`s from the `ObservedBehaviorQuery` port, not documents (C-21, R-10a). They are
interleaved into the ordering by tier like anything else; `capturedAt` in the sort key is
`observedAt` for an observation and `document_version.captured_at` for a document.

Ranking inputs are **metadata only** — source class, provenance, freshness, lexical and vector
scores. Document text never influences the ordering rule that places it (FR-026, R-11).

### Degradation order

Structural path first, then the observation port, then lexical, vector last. A budget cut removes
recall before it removes identity matches — and it removes the top trust tier last, because a
`current_behavior` answer without observations is the wiki's answer — and the response says which
sources went unconsulted (002 FR-012).

## 2 · Anchor resolution — the surface 008 uses

```ts
/** The ONLY way to obtain an anchor. Returns a grant id, not an expectation id. */
interface AnchorResolver {
  resolve(scope: { componentNodeId: NodeId; featureNodeId?: NodeId; }):
    Promise<ReadonlyArray<{
      anchorGrantId: Uuid;                  // 008 FR-006 stores THIS
      expectedBehaviorVersionId: Uuid;
      stableKey: string;
      description: string;
      constraints: ReadonlyArray<ConstraintValue>;
      adoptedBy: string;                    // named human
      adoptedAt: string;
    }>>;
}
```

There is no method taking an `expectedBehaviorId` and returning anchor eligibility, and no method
returning a draft as an anchor. An unadopted expectation has no `anchor_grant` row, so it cannot be
named (R-01).

| Situation | Result |
|-----------|--------|
| Adopted version, grant live | returned |
| Draft, never adopted | absent — nothing to return (FR-010) |
| Adopted then edited | the **adopted** version is returned, not the edit (FR-012) |
| Adoption revoked | absent from this call; the stored grant id in a past verdict still resolves (FR-013) |
| Retired | absent as an anchor, readable as history (User Story 1, scenario 5) |
| No expectation covers the behaviour | empty array → 008 FR-007 / 006 FR-011 `NO_EXPECTATION` |

An anchor request that finds nothing is recorded as a refusal with its reason (FR-010) — 008 must
not be able to distinguish "we had no anchor" from "we did not ask".

### Adoption is human-only, and Healer cannot approve its own

| Path | Actor | Gate |
|------|-------|------|
| Repository markdown — **the only v1 path** (C-06) | merge request approver | Healer's GitLab credential holds no approval permission; an adoption whose approver is Healer's service identity is rejected (R-02) |
| In-product adoption — **deferred, not in v1** (R-16) | would be an authenticated human holding `knowledge:adopt` | the capability exists in the permission model and is absent from every agent and automation credential; **no endpoint serves it in v1**, so there is nothing to gate yet |

`seeded_from` on the adoption record names the source artifacts the draft came from (FR-011), so a
year later it is answerable *what* a person adopted, not only that they did.

## 3 · Constraint resolution — no model in the path

```ts
interface ConstraintResolver {
  resolve(name: string, scope: ConstraintScope):
    Promise<
      | { outcome: 'found'; valueType: ValueType; value: Json;
          documentVersionId: Uuid; provenance: Provenance; anchorGrantId: Uuid }
      | { outcome: 'not_found' }
      | { outcome: 'conflict'; definitions: ReadonlyArray<ConstraintDefinition> }
    >;
}
```

The resolver **counts**, it does not rank (FR-015, R-07). Two authoritative definitions of
`max_payment_retries` return a conflict naming both; a policy predicate receives an error rather
than a tie-broken value. A `machine_generated`, unadopted constraint is citable but is never
`found` as an authoritative value (FR-008): it has no `anchorGrantId`.

Zero model calls on this path, asserted by a test that fails if the LLM interface is reachable from
the resolver's dependency graph (SC-010).

## 4 · The document format in the customer's repository

One markdown file per feature under a configured path (C-06, R-08). Front matter is machine-readable;
the body is prose.

```markdown
---
feature: checkout
component: checkout-api            # resolved against the confirmed graph (004)
expected_behaviors:
  - id: checkout-002               # stable_key — survives edits and heading renames
    description: duplicate checkout cannot create duplicate order
  - id: checkout-003
    description: a declined payment never reserves inventory
constraints:
  max_payment_retries:            { type: int, value: 3 }
  inventory_reservation_timeout:  { type: duration, value: 15s }
---

## Checkout

Prose for humans. Never parsed for values, never a ranking input, never a predicate input.
```

- Front matter parses into `expected_behavior_version` and `knowledge_constraint` rows. A malformed
  block fails that file's ingest with a named error and leaves the previous version in place.
- `id` is the stable identifier. A renamed heading or reworded description is a new *version*, not a
  new expectation.
- **Freshness and authorship come from git**: last commit touching the file, and its author. Neither
  is self-reported, and neither cost an adapter (C-06).
- **Adoption is the merge.** The merge request is the review; the approval is the adoption record.

### The write path never publishes

Healer opens a merge request and stops (FR-021, D-23). It does not commit to a default branch, does
not edit a document in place, and does not publish to any customer knowledge system. Every generated
document carries a named human owner before it is proposed at all (SC-007).

## 5 · Events

Published through the transactional outbox (012 FR-031).

| Event | When | Key payload | Consumed by |
|-------|------|-------------|-------------|
| `ExpectationDraftProposed` | seeding produces a draft | `expectedBehaviorId`, `seedingSessionId`, `extractionRule` | dashboard |
| `ExpectationAdopted` | a human adoption writes a grant | `anchorGrantId`, `expectedBehaviorVersionId`, `actorRef` | 008, 011, dashboard |
| `ExpectationAdoptionRevoked` | a human revokes | `anchorGrantId`, `revokedBy`, `reason` | 008, dashboard |
| `KnowledgeDriftFindingRaised` | drift is raised | `findingId`, `kind`, `issueId`, `documentVersionId?`, `expectedBehaviorVersionId?` | 001, dashboard |
| `DocumentVersionIngested` | a new version syncs | `documentId`, `versionNo`, `sourceModifiedAt` | dashboard |

`ExpectationAdopted` is a fact about a human act, which is why it is the one event in this feature
that changes what a verification may do.

**Three producers, three names — resolved.** Drift is detected in three places with three different
payloads, and a shared name would mean a consumer subscribing to a payload it was not built for:

| Producer | Event | Announces |
|----------|-------|-----------|
| 005 | `KnowledgeDriftFindingRaised` | a `knowledge_drift_finding` row of this feature |
| 006 | `DiagnosisFoundKnowledgeDrift` | diagnosis concluded code and an adopted expectation disagree |
| 004 | `GraphDriftDetected` | the graph and observed reality disagree |

All three raise an `Issue` of kind `knowledge_drift` (001 FR-001a), which terminates at human
adjudication. The event names differ because the payloads and the evidence behind them differ.

## 6 · What this contract forbids

- No anchor without an `anchor_grant` written by a human adoption (FR-010, SC-001).
- No adoption by an agent, an automation credential, or Healer approving its own merge request.
- No in-product adoption path in v1 — the merge-request approval is the only one (R-16).
- No second store of a revocation: `anchor_grant.revoked_at` is the record, and every other view of it
  is derived (FR-013).
- No `RetrievalResult` that is a document and an observation at once, and no observation carrying a
  document version, a section or a document provenance (FR-029).
- No retrieval without a declared question type (FR-004).
- No document text reaching a ranking rule, a policy predicate, a tool argument or a constraint
  value (FR-026).
- No constraint conflict resolved by ranking (FR-015).
- No automatic publish to a customer system (FR-021).
- No scheduled job writing to `anchor_grant` — adoption does not expire (R-09).
- No cross-tenant candidate entering a ranking, including inside an ANN scan (FR-027, R-05).
