# Phase 0 Research: engineering foundation

Each entry is a decision, why it was taken, and what was rejected. Nothing here is left open.

## R-01 · Module boundaries by pattern, not by name list

**Decision**: `no-restricted-imports` uses path patterns — `**/*/infrastructure/**` for cross-module
infrastructure imports, provider SDKs outside `packages/llm/*/infrastructure/**`, `@prisma/client`
outside `**/infrastructure/**` and `prisma/**`, `process.env` outside `packages/shared/config/**`.

**Rationale**: a name list goes stale the moment someone adds a module, and the failure is silent —
the new module simply is not governed. Patterns govern modules that do not exist yet.

**Alternatives**: enumerating modules (stale by construction); a custom ESLint rule reading the
package graph (more code than the problem deserves).

## R-02 · Detecting "never wait inside a job" statically

**Decision**: two mechanisms. A lint rule forbids `setTimeout`, `sleep`, polling loops and awaiting
an external completion inside anything under `**/processors/**`. At runtime every job carries a
declared wall-clock budget; exceeding it fails the job and raises an operational alert rather than
silently succeeding late.

**Rationale**: the static rule catches the obvious shapes; the runtime limit catches the ones nobody
predicted. Violating this rule is what would eventually force a Temporal migration (ADR 0003), and
the violation is invisible until it is expensive.

**Alternatives**: review discipline alone (fails at the first deadline); runtime limit only (catches
it after the pattern has spread).

## R-03 · Runner protocol versioning

**Decision**: the runner declares a protocol version and a capability set at registration and on
every heartbeat. The control plane computes the usable capability set as the intersection. Read-only
capabilities that are missing degrade **explicitly** — the gap is recorded as evidence and shown.
Any state-changing capability that is missing causes refusal with a stated reason. Below two minor
versions or ninety days, whichever comes first, the control plane refuses the runner entirely.

**Rationale**: a mutation executed by older logic without warning is the failure this product cannot
have. Degrading a read path costs completeness, which is visible; degrading a write path costs
correctness, which is not (C-02).

**Alternatives**: strict lockstep (every release becomes a forced upgrade at the customer); uniform
graceful degradation (silently permits stale mutation logic).

## R-04 · The evidence contract is a closed list

**Decision**: the runner may send only the declared evidence shapes. **The membership of that list
lives in one place — [contracts/runner-protocol.md](contracts/runner-protocol.md) — and is not
restated here**, because three divergent copies of a closed list is the same failure as having no
closed list (FR-022). Anything not in it is not transmitted; every fact family has its own shape
rather than travelling inside `tool_output_summary` (C-20). Free-form string fields are rejected by
schema validation, the same way the analytics-style event contract is, and the schema is versioned.

**Rationale**: "do not send raw logs" as a guideline decays. As a closed schema it is enforceable,
testable, and it is the artifact a customer's security review actually reads.

**Alternatives**: redaction filters over free-form payloads (a denylist is never complete).

## R-05 · Unredactable items are withheld, not truncated

**Decision**: where a redactor cannot establish that an excerpt is safe, the item is withheld and a
collection gap is recorded naming what was withheld and why. It is never sent truncated or
best-effort.

**Rationale**: a partially redacted excerpt is still customer data. A recorded gap is honest and
keeps 001 FR-009 satisfiable — the gap itself is an evidence record.

## R-06 · Blind debuggability of the runner

**Decision**: the runner produces a diagnostic bundle containing versions, capability set,
configuration with values redacted to presence-only, queue depths, timing histograms, error
signatures of its own failures, and the last N control-plane exchanges with payloads replaced by
schema identifiers and sizes. No customer data, no source, no log bodies.

**Rationale**: every support call is blind by design (ADR 0001). Without this, the answer to "the
runner is misbehaving" is "please read these logs to us", which does not survive contact with a
security team.

**Alternatives**: remote shell access (defeats the deployment model); asking the customer to
forward logs (that is the data we designed the boundary to keep out).

## R-07 · Prompt immutability

**Decision**: prompt versions are content-addressed and stored immutably. Authoring happens in the
repository; publishing computes the digest and writes the version record. A digest that already
exists is a no-op. Runtime resolves prompts by version identifier only, never by path.

**Rationale**: an audit entry from a year ago must resolve to the exact text used (001 FR-012), and
the benchmark (011) must measure a stable target. Reading from the working tree makes
`promptVersion` a claim rather than a fact.

**Alternatives**: git tags (history can be rewritten, and the runtime would still read a path).

## R-08 · Per-tenant provider configuration and the fallback trap

**Decision**: provider configuration is resolved per tenant on every call. Fallback chains exist
**within** a tenant's declared provider scope only. A tenant using their own model access never
falls back to Healer-provided access — on provider failure the work fails with a stated reason and
is retried later.

**Rationale**: an ordinary retry-with-fallback would route that tenant's source code to our
provider, breaching the exact contract that made them adoptable (ADR 0006). This is the kind of
failure that is discovered during an audit, not during testing.

**Alternatives**: global fallback with an opt-out (the default is the dangerous direction).

## R-09 · `make ci` as the single entry point

**Decision**: `ci` calls focused targets; developers may call the focused targets directly while
iterating. **The composition is defined once, in
[contracts/make-targets.md](contracts/make-targets.md)**, and is not restated here — a second list of
gates goes stale the first time one is added, and a gate that exists in only one of the two lists is
exactly the gate nobody runs.

**Rationale**: a gate that cannot be reproduced locally is a gate developers route around, and the
first time it fails in CI it is treated as CI being broken rather than the change being wrong.

## R-10 · Gates fail closed

**Decision**: where a gate cannot determine the answer — the change set is not inspectable, the
base commit is missing, the schema cannot be introspected — it fails rather than passes.

**Rationale**: the gates encode the constitution's non-negotiable principles. A gate that passes
when confused is worse than no gate, because it produces a false record of compliance.

## R-11 · Coverage floors are risk-weighted, not uniform

**Decision**: 95% for `packages/domain/policy/**`, `packages/domain/evidence/**`,
`packages/shared/tenancy/**` and the structured-output validation in `packages/agents/**`; 80%
elsewhere.

**Rationale**: uniform high coverage buys tests of getters. These four are where being wrong is
expensive: a policy bug permits an action, an evidence bug loses the audit trail, a tenancy bug ends
the company, and an output-validation bug lets unstructured model text into the domain.

## R-12 · Testcontainers over a shared development database

**Decision**: e2e tests start disposable Postgres and Redis instances.

**Rationale**: tenant-isolation tests must be able to create two tenants and assert that one cannot
see the other; a shared database makes those tests order-dependent and quietly flaky. Flaky is worse
than slow here, because 008 forbids a flaky result from counting as proof.

## R-13 · Who is an agent: the host's bot flag, not a list and not commit text

**Decision**: a change set is agent-authored when the pull request's author **or** the user that
triggered the workflow is a bot account on the VCS host. Healer's repository is on GitHub (C-37): the
agent is a GitHub App, and the pull request's `user.type` and the workflow's triggering actor resolve to
`type: Bot`. Every coding agent
pushes with such a token and with nothing else. If either identity cannot be resolved, the change set
is agent-authored (FR-054, R-10). Locally there is no host to ask: the gate evaluates the change set as
agent-authored unless the developer declares the identity. The gate's verdict is a function of the
change set **and** the identity, so a local run given the identity CI resolves reaches the verdict CI
reaches (FR-007, SC-001); only the CI evaluation is authoritative, because only there is the identity
resolved rather than declared.

**Rationale**: commit author, trailers and pull-request text are chosen by the author, so a rule keyed
on them is a rule the agent can opt out of. The bot flag is set by the host when the token is created
and needs no list in the repository — a list of agent identities would be one more closed list to keep
in step with the host.

**Alternatives**: a committed allowlist of agent accounts (a second authority beside the host's own
flag); a commit trailer such as `Agent: true` (forgeable by exactly the author it constrains).

## R-14 · Red-first is a run against the base revision

**Decision**: `gate-red-first` takes the test files the change set adds or modifies, places them over a
checkout of the base revision's production code, runs only those files, and passes when at least one
fails. Any failure counts — an import of a not-yet-existing export is the ordinary first red of TDD —
because `typecheck` on the head already proves the tests compile against the change. A task line
marked `[NB]` (no behaviour change) skips the gate; the marker is read from `tasks.md` **on the base
revision**, so the change set cannot add it to itself.

**Rationale**: "the agent says it saw the test fail" is a claim; re-running it against the base is a
fact the build can check. It costs one extra run of a handful of test files.

**Alternatives**: mutation testing of the change (expensive, and answers a different question);
requiring a separate red commit (history can be fabricated in any order).

## R-15 · Protecting pre-existing tests from the implementer

**Decision**: in an agent-authored change set, `gate-agent-scope` fails on a deleted test file that
exists on the base revision, and on any removed line in such a file that contains an assertion call
(`expect(`, `assert`). Added lines, including new assertions in old files, pass.

**Rationale**: Principle II applied to our own development — an implementer that can weaken the test
that judges it is verifying against its own conclusion.

**Ceiling**: a line-level heuristic. Reformatting or moving an assertion trips it, and the answer is a
human-authored change, not a smarter gate. An assertion weakened by editing a helper it calls is not
caught; the shared helpers in `test/*.ts` are protected paths for that reason.

## R-16 · Where agents run, merge rights and budgets

**Decision**: an agent task runs as a GitHub Actions job — the job's fresh checkout is its worktree,
its token is the GitHub App's installation token (contents and pull requests: write; no administration,
not a bypass actor), and parallel `[P]` tasks are parallel jobs; a task not marked `[P]` joins one
`concurrency` group, so the host serialises it. `timeout-minutes` is the wall-clock budget; the spend
budget is the model key's own limit, one key per agent job class. Merge rights are a repository
**ruleset** on the default branch: pull request required, code-owner review required with
`CODEOWNERS` naming humans only (so no App approval can satisfy it), approval of the most recent push
required, and **restrict updates** with maintainers as the only bypass actors in pull-request-only
mode — the App can push branches and open pull requests, and cannot move the default branch. An open question (FR-058) is a **draft** pull request labelled
`needs-decision`, with the question in its description.

**Rationale**: every one of these controls is a host or provider setting that the agent's prompt
cannot reach. A job clone also makes "never share a working tree" true by construction.

**Reader**: the ruleset lives in host settings, which a gate running without hosted services
(FR-007) cannot read. A scheduled workflow reads it through the GitHub API and fails on any drift from
the declared settings (C-40); quickstart 41 exercises the refusal itself at setup.

**Alternatives**: agents on developer laptops (the token and the budget become whatever that laptop
has); a hand-written orchestrator (a CI job already is one).

## R-17 · Where our own telemetry goes

**Decision**: every process exports through one OpenTelemetry Collector to Grafana Cloud — traces
(Tempo), logs (Loki; Pino to stdout, collected), metrics (Prometheus) (C-41). The collector is
configuration, not code; its endpoint and token are validated at start like any other key (FR-043).
Before export, `tenantId` is replaced by a keyed hash; `correlationId` is kept. Alerts fire on state:
a `workflow_run` past its budget, dead-letter depth, the rate of `timeout` transitions, cost per issue
from `agent_run` (FR-036), and runner heartbeat gaps.

**Rationale**: FR-037 requires operator access to a tenant's telemetry to be tenant-scoped and
audited. A hosted backend cannot audit per-tenant reads for us, so the telemetry carries nothing that
names a tenant, and the only way from a hash to a tenant is an application read that writes its own
audit entry. Redaction stays at the emission point (FR-035); the collector is not trusted to do it.

**Next step, not alternative**: self-hosted Grafana, Loki, Tempo and Prometheus under Docker Compose
(FR-052), when an enterprise review requires telemetry in our infrastructure or the bill exceeds the
cost of running it. Only the collector's exporter changes (C-41).

**Alternatives**: Sentry plus host logs; exporting `tenantId` in clear and relying
on vendor access controls (satisfies scoping, not auditing).

## Unresolved

Nothing. Healer's own repository is hosted on GitHub (C-37) and is not yet under version control;
the v1 VCS adapter for customers stays GitLab. Runner distribution format and compatibility window were resolved as C-01 and C-02
([decisions.md](../../docs/decisions.md)).
