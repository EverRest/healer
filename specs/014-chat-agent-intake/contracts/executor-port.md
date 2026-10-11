# Contract: `AgentExecutor` port and the signed callback

How work reaches an agent and how its status comes back (FR-016..FR-020). Names no product; the
GitHub Actions executor is the first implementation (research R-01), a self-hosted worker and
Healer's own runner later ones. Declared in `packages/domain/intake/src/domain/agent-executor.ts`;
adapters in `packages/integrations/src/<host>/`.

## Port

```ts
interface AgentExecutor {
  readonly name: string;                                   // stored on work_job.executor
  dispatch(directive: Directive): Promise<DispatchResult>;
  cancel(binding: RunBinding): Promise<'cancelled' | 'already_ended' | 'failed'>;
}

interface CallbackVerifier {
  /** Verifies the host-issued identity token and returns its bound claims, or refuses.
   *  Never receives the job — binding is checked by the domain against work_job (FR-017). */
  verify(token: string): Promise<{ status: 'verified'; claims: RunClaims } | { status: 'refused' }>;
}

type DispatchResult =
  | { status: 'dispatched'; binding: RunBinding }          // run id known now, or null until `started`
  | { status: 'refused_by_host' }                          // 4xx: not retried → dispatch_failed
  | { status: 'unavailable' };                             // 5xx / network: retried with backoff

interface RunBinding { repositoryId: string; workflowRef: string; runId: string | null; runAttempt: number | null }
interface RunClaims  { repositoryId: string; workflowRef: string; runId: string; runAttempt: number; event: string; actor: string }
```

### `Directive` — closed shape

| Field | Source |
|-------|--------|
| `jobId`, `workItemId`, `attempt` | `work_job` |
| `kind` | `investigate` · `fix` · `task` (never `finding` — refused by the domain) |
| `grant` | `read_only` · `branch_and_pull_request` — selects the workflow (research R-06) |
| `taskRef` or `ledgerRef` | typed, validated fields of the work item |
| `promptVersionId` | the registered fixed prompt for this kind (research R-09) |
| `description` | the post's text, one data block, never interpolated into the prompt (FR-002) |
| `budget` | `{ wallClockMinutes, spendCapUsd }` — informational; the hard stops are the workflow's `timeout-minutes` and the model key's limit (FR-014) |
| `callbackUrl`, `audience` | where and for whom the run requests its identity token |

The directive carries no secret and no credential (FR-031). For the GitHub Actions executor it is
sent as `workflow_dispatch` inputs; the description travels as one input and is written to a file
by the workflow, never expanded into a shell command.

## Callback route

```text
POST /api/v1/intake/jobs/{jobId}/events
Authorization: Bearer <host identity token>
```

Processing, in order — each failure changes nothing:

| Step | On failure |
|------|-----------|
| `CallbackVerifier.verify` (signature, issuer literal, audience, expiry) | 401, structured log and counter only — no tenant is known yet, and an audit entry needs one |
| tenant = intake configuration's tenant for `claims.repositoryId` | 404, logged and counted (a valid token of an unconfigured repository) |
| load `work_job` by `(tenant, jobId)` | 404 (another tenant's job is indistinguishable from none) |
| claims match the job's binding — research R-04's table; bind the run on the first `started` if unbound | 403, audit `callback_refused` |
| body parses against the event schema below | 422, audit `report_invalid` for an `ended` |
| guarded update on `(job, seq)` and the work item's graph (data-model.md) | 200 `{ applied: false }` for a duplicate or stale event — idempotent, not an error |

### Event body — closed

```text
{ seq: integer ≥ 1, event: 'started' }
{ seq, event: 'step', step: <step> }
{ seq, event: 'ended', outcome: <outcome>, report: <report>, cost?: { amountUsd, inputTokens, outputTokens, modelId, provider } }
```

`seq` is assigned by the workflow's own steps, not by the model: `started` = 1, each workflow step
the next integer, `ended` the last. Steps and outcomes are deterministic workflow facts; the model
writes only the report file the last step validates.

**Step vocabulary (closed, FR-016):**

```text
checkout  reading_code  reading_ci  reading_issues  writing_test  running_tests
writing_change  opening_pull_request  writing_report
```

**Outcome** is a member of `job_outcome` (data-model.md), constrained by the job's grant. A budget
breach is `stopped` with `reason: budget_exhausted`; the cost is stored as reported and labelled so
(FR-030, C-95).

**Investigation `report`:**

```text
{ verdict: 'found' | 'not_found' | 'inconclusive',
  findings: [{ claim: string ≤ 500, refs: [ref, …] }] ≤ 20,
  questionForOwner?: string ≤ 500 }
ref = { kind: 'file_line', path, line, commit }
    | { kind: 'ci_run', runId }
    | { kind: 'issue', number }
    | { kind: 'pull_request', number }
```

A finding with no resolvable ref is dropped before rendering and counted (research R-10, FR-026).

**Change `report`:** `{ pullRequest?: number, draft?: number, branch?: string, question?: string ≤ 500 }`
— exactly the field the outcome names is required: `pull_request` → `pullRequest`; `needs_decision`
→ `draft` and `question`; `stopped` → `branch`.

## Identity binding for the GitHub Actions executor

The token is the run's GitHub OIDC token, requested with `permissions: id-token: write` and the
configured audience. Bound claims and the reason for each: research R-04. Library: ADR 0019
(Proposed); until accepted only the fake verifier exists.

## Contract suite (US6 AS2)

Run against the fake executor and the GitHub Actions executor (the latter against a recorded fixture
server). It names no product. It asserts: `dispatch` with each grant reaches the workflow that grant
names and no other; a `finding` directive cannot be built; a host 4xx is `refused_by_host`, a 5xx
`unavailable`; `cancel` on an ended run is `already_ended`; a token from another repository, another
run, another attempt or the other workflow is refused by the domain's binding check; a step outside
the vocabulary and an outcome outside the grant's set fail the schema.
