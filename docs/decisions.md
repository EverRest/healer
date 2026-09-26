# Decision record

Decisions taken during the design conversation of 2026-09-23. Each entry is binding until
superseded by a later entry or an ADR.

## Product

| ID | Decision | Consequence |
|----|----------|-------------|
| D-01 | Product to sell, not an internal tool | Multi-tenancy, DPAs, procurement-grade security story |
| D-04 | Design partner: transl8.ai | Own product — repos, incidents and wiki without NDA friction |
| D-19 | Headline metric: share of incidents with a useful automated diagnosis, scored by the engineer | At L2 we do not merge, so MTTR cannot honestly be claimed as ours |
| D-19a | Carve-out: reversible remediation (D-14) **is** autonomous, so MTTR is a legitimate metric for that surface alone — measured as time-to-verified-remediation, never as an unqualified product-wide MTTR claim | Amended 2026-09-23 after spec 010; the D-19 reasoning still holds for the code-fix path (008) |

## Scope

| ID | Decision | Consequence |
|----|----------|-------------|
| D-11 | v1 = read-only core + reproduction + TDD fix + PR, plus AutoSupport and safe remediation | Large v1; needs internal milestones |
| D-12 | Autonomy ceiling year one: L2 — PR only | Cost of a wrong fix is bounded by review time |
| D-13 | AutoSupport in v1 | Second surface on the same core; supplies labelled eval data |
| D-14 | Safe reversible remediation in v1, including autonomous rollback | The only autonomous production action in year one |
| D-18 | v1 target: monorepo, several components (BE + FE + worker) | Cross-component reasoning in scope; single dependency graph |

## Deployment and isolation

| ID | Decision | Consequence |
|----|----------|-------------|
| D-02 | Hybrid: Healer control plane, customer execution plane | Runner is a shipped, versioned product; Context Resolver is distributed |
| D-17 | Multi-tenant data model from day one | `tenantId` enforced at the query layer everywhere |
| D-15 | Healer LLM key by default, customer BYO as enterprise option | Provider configuration is per-tenant from day one |
| D-16 | Fast unit tests in sandbox, full suite and e2e via customer CI | Sandbox avoids most of the secrets problem |

## Model and knowledge

| ID | Decision | Consequence |
|----|----------|-------------|
| D-03 | Generic Component/graph model, one adapter set in v1 | New architecture support = new adapter, not new agents |
| D-20 | `ExpectedBehavior` seeded from existing artifacts → draft → explicit human adoption | Only adopted entries are verification anchors |
| D-21 | AutoSupport intake via webhook / email / GitLab issues | No helpdesk adapter in v1 |

## Technical, taken without asking

| ID | Decision | Rationale |
|----|----------|-----------|
| D-05 | Postgres + pgvector; no graph DB, no vector DB | Graphs of this size fit recursive CTEs; fewer moving parts |
| D-06 | MCP outward-facing only | Internal calls keep types and transactions; permission enforcement stays in one place |
| D-07 | Prompts are versioned artifacts with eval history | Otherwise the benchmark measures a moving target |
| D-08 | Rejected diagnosis → one re-diagnosis attempt, then human | Bounded loop |
| D-09 | `ComponentType` = narrow type + characteristics | Same argument that rejected `architecture.type` as an enum |
| D-10 | Evaluation-designated routing in the eval harness only, **resolved within the tenant's declared provider scope**. A BYO tenant is benchmarked through their own provider, and the routing used is recorded and forms part of the run's configuration digest | Routing variance would contaminate the benchmark; pinning an exact model at an exact provider serves that purpose. Reading D-10 as "always route evaluation through the shared router" would breach 012 FR-046 for a BYO tenant — silently, and discoverable only by audit (amended 2026-09-24 after plan 011) |
| D-22 | BullMQ, not Temporal — enforced by "never wait inside a job" | Keeps the upgrade cheap instead of becoming a rewrite |
| D-23 | Generated documents are drafts with a named human owner | Prevents Healer citing itself as authority |

## Clarifications (2026-09-24)

Seven `[NEEDS CLARIFICATION]` markers resolved. Four were resolved by reframing rather than by
choosing a value — the question dissolved once the asymmetry or the ownership was made explicit.

| ID | Decision | Why this rather than the alternative |
|----|----------|--------------------------------------|
| C-01 | The container image and its contract are the runner product. Exactly one deployment wrapper in v1, matching what the design partner runs | Building both Compose and Helm paths means testing and supporting two upgrade/rollback routes before a single real customer exists |
| C-02 | Version divergence uses a capability handshake: read-only paths degrade explicitly and record what was missing; any state-changing path refuses. Hard floor N‑2 minor versions or 90 days | A mutation executed by older logic without warning is the failure this product cannot have. Strict lockstep makes every release a forced upgrade at the customer |
| C-03 | An unconfirmed graph edge may only **widen** blast radius and raise risk — never narrow it, lower it, or satisfy a permission condition. No provenance threshold needed | The two errors have different costs: widening costs extra human review, narrowing permits an action that should have been blocked. A single numeric threshold treats them as equal |
| C-04 | Healer retains no reproduction fixtures. Where a regression test needs fixture data it is committed to the customer's repository with the test | The fixture must live in their repo anyway for their CI to run the test. Retaining a second copy adds derived customer data at rest and a DPA clause, and buys nothing |
| C-05 | No autonomy-governing threshold may be derived from a run containing any synthetic incident. Real and synthetic metrics are never combined into one figure | Synthetic incidents are easier than life. A threshold inflated by them permits more autonomy than earned — precisely the failure mode the product exists to prevent. If real yield is too small, no threshold exists and L2 stands |
| C-06 | No hosted-wiki adapter in v1. `KnowledgeSource` exists; the only text adapter is repository markdown | Git supplies freshness and authorship free, and adoption of an `ExpectedBehavior` passes through code review — which *is* the human adoption gate. A hosted wiki provides none of the three, and costs a full adapter |
| C-07 | AutoSupport allowlist starts empty; a category becomes eligible only after a measured number of drafts were sent unedited without the ticket reopening. Promotion is a tenant decision | Seeding "obviously safe" categories is the guess we rejected everywhere else. Starting empty costs almost nothing, because Healer never sends and the draft is produced regardless |

## Analyze resolutions (2026-09-24)

Fifteen decisions taken after `/speckit-analyze` across all twelve specs. Each one settles a place
where two artefacts disagreed or a guarantee existed only as prose.

| ID | Decision | Why this rather than the alternative |
|----|----------|--------------------------------------|
| C-08 | **Both** policy and 008's loop read `fix_eligibility` / `change_eligibility`: `codeProblemVerdict` and `fixEligible` join `DecisionInput`, **and** 008 guards on both views at loop entry | Two indexed reads against the one gate whose failure means a patch on a Redis outage. One reader is one place to forget, and only this makes 006 FR-002's "no path reaches 008 without the classifier" literally true |
| C-09 | 010 publishes an events contract (`RemediationProposed/Dispatched/Verified/Undone/Escalated/CataloguePublished`). A human close publishes `IssueResolved(self_resolved)`. **009 releases held tickets only on `resolutionKind ∈ {remediated, fixed}` with non-empty verification evidence** — `self_resolved` escalates | Nothing emitted `IssueResolved` in v1, so every held ticket escalated by deadline. Releasing on `self_resolved` would send fifty customers a draft citing verification evidence that does not exist (FR-018) |
| C-10 | A simulation **may** send `change_plan` to the sandbox, scoped to a sandbox workspace. Repository write stays excluded | Without it `false_fix_rate` — the number the constitution defers L3 on — is permanently unmeasurable. 007 already establishes that sandbox execution sits outside ADR 0008: the workspace is destroyed and holds no credentials |
| C-11 | **002 owns** rate limits, cooldowns and attempt caps. `DecisionInput` gains `targetRef` and `fingerprint` scoping; `remediation_limit` is deleted; 010 keeps only refusal reason codes as a projection | Principle IV puts every limit in the deterministic engine that already writes a trace and a reason code. Two enforcement points with two stores and two keys will disagree, and neither was authoritative |
| C-12 | 008's `anchor_resolution` carries **`anchor_grant_id NOT NULL`** plus immutable copies of `adopted_at` and `adopted_by_actor_type`. The `state = adopted` predicate is dropped from 008 and 006 | The grant is the only thing that can *name* an anchor, so an unadopted expectation is unnameable rather than rejected. The copies serve a real need: `adopted_at < issue.first_seen_at` must stay reconstructable years later even after the grant is revoked |
| C-13 | `audit_entry` and `agent_run` both stand. 012 FR-033 is softened to "no second store of **the agent-run facts**"; `audit_entry` remains the all-actors index and 001 FR-012's model/prompt/tool fields resolve through `agent_run_id` | Different key sets: every actor including humans, runners and the system, versus one agent invocation. What was wrong was FR-033's absolutism and test T060, not the schema |
| C-14 | Timeline reads **both** `issue_event` and `workflow_transition`, with a declared boundary: domain facts in the former, machine steps in the latter. `GetTimeline` is a union query; 012 FR-029's totality claim is corrected | Different grains. A signal arriving is not a workflow transition; a job retry is not a domain fact. Both specs claimed totality, which is what made T048 untestable |
| C-15 | Rollback's undo is a **separate action key** `deployment.restore_dispatch_version`, whose single parameter must equal `remediation_attempt.revision_ref_at_dispatch` | The flagship action had no admissible undo: its own schema requires a deployment *preceding* the current one, and the undo names one that *succeeds* it. A separate key can name exactly one deployment, so forward deploy stays inexpressible (R-04) |
| C-16 | The `descendantOf` operator is **removed** from the predicate vocabulary | It read the graph inside the fold, so the evaluator was not pure and stored decisions did not replay — the graph mutates on every confirmation. No spec's scenario needs a hierarchy rule; grants already scope per component |
| C-17 | Evaluation **step 4 is deleted**. Rules express the required level themselves through `autonomy.level atLeast N` | Step 4 had no referent — nothing defined the level an action requires. The predicate vocabulary already expresses it, and the tenant's rule set is where that is visible and reviewable |
| C-18 | `ACTION_CEILING` becomes **`f(actionClass, hasTestedUndo)`**: `reversible_remediation` has no level when the undo is unattested. Enforced in the clamp *and* as a grant-time check | It is the only class with a live L5 — the one place being wrong executes an unattended production action. Leaving it to tenant rule authorship plus a build gate is the "one mechanism away from silent failure" argument R-05 already rejected for the ceiling itself |
| C-19 | **002 owns the predicate vocabulary**, including closure-shaped predicates. 004 contributes fields and references 002's operator table | 002's table is already the publish-time-validated authority, and operator domains are what make a ruleset deterministic. 004 had described four predicate forms no policy rule could express |
| C-20 | Every new boundary fact family gets **its own declared shape**: `pull_request_ref`, `config_key_ref`, `knowledge_ref` join the four graph shapes in 012's runner protocol | 012's own contract text says reusing `tool_output_summary` reopens the channel it exists to close, and 004 already set the precedent. A closed list with an escape hatch is not closed |
| C-21 | Retrieval returns a **discriminated union**: `kind: 'document' \| 'observation'`, observations carrying `evidenceId` and supplied by an `ObservedBehaviorQuery` port into 001/003 evidence | The top trust tier for "what does the system do" was unrepresentable — `RetrievalResult` required a document version and section. Ingesting observations as documents would give them versioning, freshness and adoption they have no meaning for |
| C-22 | Precedent liveness is a **graph** question. `absent` = the component or concept no longer exists in the graph; `moved` = it exists elsewhere | A plane crossing per precedent lookup for a scoring nudge is the wrong trade, and 006 is control-plane by design. Cost: "symbol deleted, component alive" reads as `moved` — less weight, never more, which is the safe direction |
| C-23 | When the only reproducing rung needed an anonymised extract, 008 **attempts a synthetic equivalent** and routes to a human if it does not reproduce. `NO_RECIPE` is an explicit off-ramp | 007 R-06 already promised it, and the attempt is cheap because the failing constraint is known. Allowing a recipe for an anonymised extract would reopen C-04 exactly where the data is most sensitive |

## Reproduction of client-side symptoms (2026-09-24)

| ID | Decision | Why |
|----|----------|-----|
| C-24 | **Two reproduction ladders**, selected by the directive's `observableLocation` (`server` · `client` · `undetermined`) and never by `issue.kind`. Server: `unit` · `request` · `data` · `concurrency` · `load` · `external_state`. Client: `client_unit` · `client_request` · `client_journey` | Playwright and any browser path had vanished from all twelve specs, while v1 targets a monorepo with a frontend (D-18) and the product's most compelling demo is a client-only symptom. One ladder is worse than two: for a browser-only observable, `unit` and `request` cannot produce a `FAIL` **in principle**, so climbing them wastes two rungs by construction — and for a log-derived endpoint error, driving a browser means booting a frontend to arrive at an HTTP request the engine could have made directly |
| C-25 | `client_journey` (Playwright) **requires a declared reason** and is refused when a cheaper rung on its ladder was never attempted | It needs the customer's frontend build, browsers in the runner image and a locally served application against a local or stubbed backend, since the sandbox has default-deny egress. The most expensive operation in the product, and the flakiest — it must not be reachable by omission |
| C-26 | `observableLocation` is derived **deterministically from the evidence**, and `undetermined` is a permitted value that yields `INCONCLUSIVE` | Who reported an issue does not predict which instrument can see it: a user report often has a plainly server-observable symptom, and an alert can fire from a client-side error reporter. A guessed location costs a whole ladder of guaranteed failures |
| C-27 | Intake captures a **trace identifier, HAR entry or console log** where the reporting system has one | It moves a client-observable report from `client_journey` to `client_request` — no browser at all. One question to a machine is the cheapest cost control in the reproduction path |
| C-28 | A change touching a component in a declared user flow has that **flow's browser journey re-run as verification**, independently of which ladder reproduced the issue | This is the half of Playwright's role the original design had right. What was wrong was "Playwright is only verification" — for a client-observable symptom it is also the only instrument that can reproduce. A server-side fix making an endpoint return 200 can still leave a spinner turning, and the endpoint regression test would never see it (failure-modes §2) |

## Stage-0 review — the thresholds and the values left unset (2026-09-24)

| ID | Decision | Why |
|----|----------|-----|
| C-29 | The golden dataset is **split**: every entry declares `split ∈ dev · benchmark`, mandatory, never updated, and only a `benchmark`-scoped run may derive a threshold (011 FR-011a, FR-021b). The first twenty adjudicated real incidents are the sealed benchmark set | The four thresholds that govern autonomy were being derived from the same incidents the prompts were tuned against. The false-fix rate then comes back optimistic by exactly the amount of tuning, and an optimistic number here raises the level at which an agent writes to a customer's repository. The split lives on the entry, not on dataset membership, because otherwise one incident is `dev` in version 3 and `benchmark` in version 4 — laundering. Sealing twenty rather than halving the set keeps S0-1's exit criterion at twenty incidents instead of forty |
| C-30 | A diff that **raises** a level in `ACTION_CEILING` must cite a resolvable `threshold_derivation` artifact; `gate-ceiling` gains that third assertion, and publishing a derivation writes a committed artifact reconciled against the row in both directions (002 FR-008a, 011 FR-021c) | `gate-ceiling` validated grant rows *against* the ceiling function and nothing looked at the function, so a pull request giving `merge` a level passed every gate in the repository — and the absence of that level is the whole of what holds v1 at L2. The thresholds existed, were impossible to fabricate, and had no reader at the one moment they matter. The citation governs the **edit**, never the evaluation: a ceiling that reads configuration can be misconfigured or cached stale, and its strength is that it is a literal in code |
| C-31 | All six adapters stay in v1; **rollback lands in staging first**, promoted per environment by grant | Cutting deploy and runtime looks right at L2 and is wrong: 010's P1 story is rollback, its catalogue is restart, scale, queue drain and flag disable, and 004's `DeploymentUnit` carries runtime identity. Staging first is not a hedge — `autonomy_grant.environment` already scopes a grant, and `ACTION_CEILING` gives `reversible_remediation` no level at all until the undo has a passing test, so staging is where that attestation is earned at zero production risk |
| C-32 | Every deliberately unset value ships a **starting value chosen to fail closed**; the four dangerous ones ship a **clamp** instead — 009's predicate 2 trust floor, 007's per-rung repeat counts, 002's escalation cap and budgets, 006's hypothesis threshold (S0-7) | 004 R-15 already did this and nothing else followed. A value nobody set is not neutral: it is whatever the code does when the column is null, decided by accident. The four are different because lowering each is individually rational — "we draft too few answers", "the repeat count is slow", "we escalate too often" — and collectively removes the product's stop rules. Written the way `CHECK (real_denominator >= 20)` is written: a literal, a constant, and a test that they agree |

Also recorded from this review: the S0-7 table listed a *"masking rejection threshold"* for 008. No such
threshold exists — 008 FR-014 is deterministic diff inspection, FR-015 a hard refusal, and SC-009 a
fixture outcome. The row is corrected, because calling something a threshold in a tracking table is how it
becomes one.

## Inference location (2026-09-26)

| ID | Decision | Why |
|----|----------|-----|
| C-33 | **A model call runs where its inputs live** ([ADR 0010](adr/0010-inference-follows-the-source.md)). The change agent, 008's masking inspection and the verifier execute in the runner against the tenant's provider; the control plane orchestrates through `agent_directive` and records `agent_run` from `agent_run_report`. The patch never crosses | The runner contract said file contents never cross, and ADR 0006 said source is in the change agent's prompt — with the agent in the control plane, both could hold only through a crossing no specification described. Rejected: a bounded `code_excerpt` shape (Healer processes source in transit, and the bound erodes), a Healer inference gateway (brings the source back through us), the whole loop in the runner (policy, budgets and audit move to infrastructure we cannot observe) |
| C-34 | A Healer-managed tenant's runner holds a **per-tenant** provider key — spend-limited, revocable, provisioned into the customer's secret manager at onboarding, never sent over the runner protocol. A customer-supplied tenant's runner uses their own account | A shared key in customer infrastructure is one leak away from every tenant's spend. The key's own limit is the hard budget stop because the control plane cannot stop a call it does not make; 002's budgets stay the policy stop, reading reported cost reconciled against provider usage per key |
| C-35 | Runner-side inference is a **declared capability**; without it every `agent_directive` is refused. Prompt text crosses towards the runner by version identifier and is refused on a digest mismatch | The change agent's path changes state, so C-02 makes refusal the only option. Prompts are Healer's text, not the customer's, so their crossing is outbound only and changes nothing in the customer's posture |

## Open questions closed (2026-09-26)

| ID | Decision | Why |
|----|----------|-----|
| C-36 | **No vector index over customer documents in v1** — closes stage-0 S0-8. 005 retrieval runs on its lexical and structured paths, which 005 FR-003 already requires to stand alone; pgvector holds nothing derived from a customer document | Both ways of embedding cost something at the boundary: vectors are derived customer content and partly invertible, and admitting document text opens a text channel through a contract built to have none. Neither is needed for v1 to work, so neither is built. Rejected: runner-side embedding with vectors as a new shape; text of documents the customer marks shareable |
| C-37 | **Healer's own repository is hosted on GitHub.** Agent identity is a GitHub App: `type: Bot` on the pull request's author or the workflow's triggering actor (012 R-13) | The owner's choice. The v1 VCS adapter for the design partner is GitLab (S0-4); C-42 adds GitHub so Healer can run on itself |
| C-38 | A Healer-managed provider key is **rotated by hand** through the customer's secret manager: Healer issues the new key, the customer stores it, the old key stays valid for an overlap window and is then revoked | Keeps C-34 whole — no credential ever travels over the runner protocol. Rejected: the runner fetching short-lived keys from the control plane (a credential on the protocol, reversing ADR 0010); customer-supplied only in production (heavier onboarding for every customer to save us one runbook) |
| C-39 | The runner's single v1 deployment wrapper is **Docker Compose** — closes C-01's open choice | The fewest moving parts, the same tool local development already uses (012 FR-050), and one upgrade and rollback path to test. A Helm chart is built when a customer needs it (C-01) |
| C-40 | The host settings that hold agent merge rights are **checked on a schedule** against the GitHub API, and drift fails that check (012 R-16, SC-022) | "Every guarantee names its reader": a setting verified once at repository setup has no reader afterwards, and a ruleset edited by an admin would silently return merge rights to the agent |
| C-41 | **Healer's own telemetry goes to Grafana Cloud through one OpenTelemetry Collector** — logs, traces and metrics. Alerts are on state, not on log text: a workflow past its budget, dead-letter growth, `timeout` transitions, cost per issue, runner heartbeat gaps. Telemetry leaving our processes carries a **keyed hash of `tenantId`**, not the identifier; resolving it to a tenant goes through the audited operator path (012 FR-037) | Nothing to operate, and the stack is the one Healer reads at customers, so the team knows it. The hash is what keeps FR-037 true with a vendor whose query access we cannot audit per tenant: an operator reading Grafana sees which investigation, never whose, until they ask the application — which records the ask. Rejected: Sentry plus host logs (two places, and a second redaction path to keep correct). **Self-hosted Grafana is the planned next step, not a rejection**: the move is triggered by the first enterprise security review that asks for telemetry to stay in our infrastructure, or by the bill exceeding what the stack would cost to run — and because code exports only through the collector, the move is a collector configuration change |
| C-42 | **A GitHub VCS adapter ships in v1** as the seventh adapter, so Healer's own repository is a tenant of Healer | The owner's choice: Healer becomes the first source of real incidents for its own benchmark, and US10's agents and 013's suite run against the same pipeline customers get. Cost recorded: one more adapter — pull requests, CI results, bot identity — added to S0-4 after the design partner's six, never ahead of them |

## Deliberately unset

`false-fix rate`, `30-day revert rate`, `per-incident cost ceiling`, escalation attempt cap —
derived from the benchmark in [stage 0](stage-0.md), not chosen in a vacuum. Since C-29 they may be
derived only from a run scoring **no synthetic entries and no `dev` entries**; since C-30 the change that
consumes them fails the build unless it cites one.
