# Implementation Plan: Grounded answers to human-reported issues

**Branch**: `009-autosupport` · **Spec**: [spec.md](spec.md) · **Date**: 2026-09-24

## Summary

A second intake surface and a second ending on the **same investigation core**. A human report
becomes an `Issue` of kind `user_report` (001 FR-001) and passes through the same context resolution
(003), knowledge retrieval (005), evidence building (001) and policy evaluation (002) as a
production alert on the same component. This feature adds channel adapters and one decision node
after diagnosis. It adds no second pipeline, no second policy engine and no second retrieval stack —
two investigation cores is two products, and the second one is never as good.

Four commitments shape the design.

**The gate is structural.** `AnswerPolicy` is a rule set evaluated by 002's engine over a record of
facts that deterministic steps computed before evaluation. Model-reported confidence is not an input
to any predicate (002 FR-003); two drafts differing only in declared confidence get the same outcome
because confidence is not a column the rules join on.

**Grounding is verified by a different step, and the deterministic direction is the safe one.**
Candidate source spans are found by deterministic matching; a model may only **reject** a candidate,
never create one. A claim with no deterministic candidate span is ungrounded, full stop. Models cite
real documents for claims those documents do not make, and a citation checked only for existence is
decoration that makes a wrong answer look rigorous.

**No factual token is ever generated.** The drafting step emits typed slots — `{{fact:…}}` — which a
deterministic binder fills from named structured fields read at draft time. A bare number, date,
amount, duration or identifier appearing in generated text outside a slot rejects the draft. Customer
text is a different risk class from a pull request: a bad PR is read by someone paid to review it, a
bad auto-reply is already in front of a paying customer.

**Healer never sends.** On `AUTO_REPLY` it publishes a draft through the outbox and stops. There is
no transport in this feature that can reach an end customer, enforced by a pattern-based build gate
(012 FR-002), and no configuration can add one (002 FR-008). This is a permanent product property,
expected to survive every autonomy increase.

**C-07 is decided**: the per-tenant category allowlist starts **empty**. A category becomes
promotable only after a configured number of consecutive drafts in it were sent unedited without the
ticket reopening; promotion is a human tenant decision. Designing the measurement is part of this
feature, and it is free — the draft is produced regardless of the allowlist, because Healer never
sends.

## Technical Context

**Language/Version**: TypeScript 5.x, Node 22 LTS

**Primary Dependencies**: NestJS 11 (`@nestjs/cqrs`, `@nestjs/throttler` for intake), Prisma 6 with
pgvector (retrieval is 005's; this feature consumes it), BullMQ, Zod (intake payloads, structured
agent output), Pino, OpenTelemetry. GitLab adapter from `packages/integrations` (012 FR-001).
**No new dependency**: email arrives as an inbound webhook from the tenant's existing mail system,
not by mailbox polling, so no mail client enters the stack table

**Storage**: PostgreSQL — `support` schema. Retrieval uses 005's pgvector index as a secondary
index, never as a source of truth (ADR 0004, 012 FR-047)

**Testing**: Vitest; Supertest e2e against disposable Postgres (012 R-12). Two corpora are product
assets: the **grounding corpus** (claims supported, unsupported and contradicted by their cited
source) and the **isolation matrix** (two tenants, near-identical documents, every channel × every
retrieval path)

**Target Platform**: control plane. Attachments and pasted logs are redacted in the execution plane
before crossing (003 FR-008, 012 FR-023); nothing in this feature reads a customer system directly

**Project Type**: `packages/domain/support`, with intake adapters in `packages/integrations`

**Performance Goals**: an accepted report is an `Issue` within 10 s of delivery; the category block
decides before any drafting cost is incurred; deterministic grounding over a draft of ≤ 20 claims
under 2 s; the whole answer path inside the per-issue budget (002 FR-011)

**Constraints**: no generated factual token; no cross-tenant retrieval, by construction rather than
by filtering; no egress carrying answer text; no `AUTO_REPLY` with a caveat — the outcome set has no
hedge in it

**Scale/Scope**: thousands of reports per tenant per month; fifty tickets held on one issue is the
normal case, not the edge

## Constitution Check

*GATE: must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | How this feature satisfies it | Status |
|-----------|-------------------------------|--------|
| I. Evidence First | Every answer carries ≥ 1 evidence reference; the grounding verdict is an evidence record emitted by the grounding step, never a field the drafting step writes (FR-008, 001 FR-008, 001 FR-009) | ✅ |
| II. Anti-Circular Verification | Citing is not grounding. The grounding step is independent of drafting, receives no rationale or self-assessment, and deterministic matching proposes while a model may only reject (FR-008, ADR 0002) | ✅ |
| III. Reproduce Before Modify | Not exercised — this feature never modifies code. A report that turns out to be a code defect routes to 006/007/008 like any other issue | n/a |
| IV. Deterministic Control | `AnswerPolicy` is deterministic, versioned, evaluated by 002; confidence is never a predicate; blocked topics are categories, not thresholds (FR-005, FR-010) | ✅ |
| V. Dependency-Aware Change | Not exercised | n/a |
| VI. Serialize / Parallelize | Retrieval fans out; the hold on a linked issue is a persisted state with a deadline and an event, never a waiting job (FR-018..020, 012 FR-025) | ✅ |
| VII. Architecture Agnostic | A ticket links to a `Component` (004) and an `Issue`, never to a service name | ✅ |
| VIII. Simplicity | Span matching, slot binding, edit-signal diffing and the promotion counter are all deterministic; no model is asked a question a string comparison answers | ✅ |

**Tenancy** is the sharpest constraint here. A support answer is the one output that leaves the
customer's organisation, so cross-tenant leakage is unrecoverable rather than merely severe. The
retrieval port takes a tenant scope as a required argument, there is no overload without it, and
ownership is re-verified on every cited document at finalisation (FR-014, FR-015, 001 FR-015).

**Autonomy**: `AUTO_REPLY` is a draft, not a send. The product-level ceiling that a tenant cannot
raise (002 FR-008) covers both direct sending and the blocked-topic set.

**Capability passing** ([ADR 0008](../../docs/adr/0008-capability-passing.md), accepted): answer
publication is one of the four irreversible operations in scope, so it takes an
`AnswerPublishCapability` as an argument and can resolve one from no container, module import,
ambient configuration or global (FR-016, R-28). That is what makes 011's no-mutation guarantee hold
over this feature's publication path, and it is the reason `gate-no-send` (R-19) can be a boundary
rule about transports rather than a runtime check inside code that already holds one.

## Project Structure

### Documentation (this feature)

```text
specs/009-autosupport/
├── plan.md · research.md · data-model.md · quickstart.md
└── contracts/
    ├── openapi.yaml        # intake, reads, allowlist administration, send reporting
    ├── answer-policy.md    # the eight predicates, their order, and what each reads
    └── events.md           # domain events published and consumed
```

### Source code

```text
packages/domain/support/
├── domain/           # SupportTicket, AnswerDraft, Claim, Citation, AnswerPolicy predicates,
│                     # SlotBinder, GroundingMatcher, EditSignal, CategoryEligibility
├── application/
│   ├── commands/     # AcceptReport, ClassifyCategory, AssembleDraft, BindStructuredFacts,
│   │                 # VerifyGrounding, DecideAnswer, HoldTicket, ReleaseHeldTickets,
│   │                 # RecordSend, RecordReopen, PromoteCategory
│   └── queries/      # GetTicket, GetDraft, GetAnswerDecision, ListHeldTickets,
│                     # GetCategoryEligibility, QueryFeedback
├── infrastructure/   # Prisma repositories, outbox publisher, retrieval port binding (005)
└── presentation/     # intake controllers, DTOs, send-report callback

packages/integrations/
├── webhook-intake/   # generic signed webhook
├── email-intake/     # inbound webhook from the tenant's mail system; thread and quote handling
└── gitlab/           # issue intake (shared with 008)

packages/agents/support/   # drafting and claim decomposition — two prompt keys, two runs
```

**Structure decision**: the drafting agent and the claim decomposer are separate prompt keys with
separate runs, and the grounding matcher is not an agent at all. One agent that drafts and then lists
its own claims would be grading its own paper twice — the decomposition would name exactly the claims
it knows it can support and stay silent about the rest.

Intake adapters live in `integrations`, not in `domain/support`, because the domain must not know
whether a report arrived by email or by webhook. That is what makes "one investigation core" true
rather than aspirational.

## Phase 0 — research

See [research.md](research.md): the shared workflow and where it branches, intake normalisation and
email threading, predicate ordering so blocked topics cost nothing, claim decomposition and why
matching is deterministic-proposes / model-rejects, slot binding, blocked set versus allowlist, the
C-07 promotion measurement, isolation by construction, release on production verification and not on
merge, the hold ceiling, edit and reopen signals, the egress gate, and the cross-language ceiling we
accept.

## Phase 1 — design

- [data-model.md](data-model.md) — the `support` schema: tickets, issue links, drafts, claims,
  citations, structured fact bindings, grounding verdicts, predicate results, feedback and the
  category eligibility counters.
- [contracts/answer-policy.md](contracts/answer-policy.md) — the eight predicates, their evaluation
  order and their inputs. This is the document a reviewer checks Principle IV against.
- [contracts/openapi.yaml](contracts/openapi.yaml) — intake, reads, allowlist administration and the
  send-report callback.
- [contracts/events.md](contracts/events.md) — the draft-ready event and what this feature waits on.
- [quickstart.md](quickstart.md) — scenarios, most of them refusals.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|-----------|-----|--------------------------------------|
| Typed fact slots instead of checking numbers after generation | FR-012 must hold for tokens nobody thought to pattern-match | Extracting numbers from prose and verifying them misses the amount written as "forty euros", and that is precisely the one that starts a refund dispute |
| Deterministic matching proposes, model only rejects | A model asked whether a document supports a claim is a model asked to approve its own sibling's work | A model entailment judge as the primary matcher has better recall and no floor — it can ground anything if asked persuasively |
| Separate claim decomposer from the drafting agent | The decomposer decides what gets checked | One agent doing both names the claims it can defend and omits the rest, which is undetectable downstream |
| Category eligibility counters kept per tenant per category | C-07 requires promotion to be earned by measurement, not judgement | Seeding "obviously safe" categories is the guess this project rejected everywhere else |
| Drafts produced for non-allowlisted categories | Without them the promotion measurement has no input and the allowlist can never leave empty | Skipping drafting outside the allowlist makes C-07 unimplementable — the tenant would have nothing to promote on |
