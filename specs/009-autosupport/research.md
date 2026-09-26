# Phase 0 Research: grounded answers to human-reported issues

Each entry is a decision, why it was taken, and what was rejected. Nothing here is left open.

## R-01 · One workflow definition, branching after diagnosis on `issue.kind`

**Decision**: there is a single investigation workflow (012 FR-029). Nodes up to `diagnosed` are
shared by every issue kind. A branch node keyed on `issue.kind` routes `user_report` to the answer
decision and every other kind to the change or remediation paths. 009 contributes channel adapters,
the branch's target subgraph, and nothing else. It has no retrieval stack, no policy engine and no
evidence store of its own.

**Rationale**: the architectural bet of the feature. Two intake surfaces over one core is cheap; two
cores is two products, and the second gets the leftover attention. It is also how the independent
test in User Story 1 is even expressible — the same failure submitted twice must produce the same
evidence set and diagnosis.

**Alternatives**: a support-specific lightweight pipeline "because tickets are simpler" (they are not
— a ticket with no logs needs *more* context resolution, not less, and the shortcut would be
discovered as a quality gap six months in).

## R-02 · Email intake is an inbound webhook, not a mailbox

**Decision**: all three channels are HTTP. The tenant's existing mail system forwards inbound mail to
a signed Healer webhook; Healer does not poll IMAP, hold mailbox credentials or run a mail client.
Delivery identity per channel: provider delivery id (webhook), `Message-ID` (email), project +
issue IID + note id (GitLab). All three land in 001's `ingestion_delivery` for idempotency
(001 FR-004, FR-002).

**Rationale**: a mailbox client is a new dependency, a new credential class and a new failure mode
outside the constitution's stack table, bought for a channel the design partner can forward in one
rule. Keeping every channel HTTP also means one retry story and one signature story.

**Alternatives**: IMAP polling (credentials at rest, duplicate delivery semantics of its own, and an
ADR we do not want to write).

## R-03 · Only the newest message is the report; quoted history is bounded context

**Decision**: deterministic quote stripping — quote markers, `On … wrote:` separators, signature
delimiters — isolates the newest message, which becomes the report. The remainder is retained as a
bounded excerpt (001 FR-011) linked as context evidence. Both are data, neither is instruction
(FR-023).

**Rationale**: a forwarded thread contains three previous answers, two of which may be wrong. Feeding
the whole thread as the report makes the system answer a question nobody asked, and quoted text is
the most attacker-convenient place to hide instruction-shaped content.

## R-04 · Predicate order is chosen so blocked topics cost nothing

**Decision**: evaluation order is category classification → blocked-topic check → hold check →
retrieval → draft assembly → structured-fact binding → independent grounding → finalisation tenant
re-verification. A blocked category terminates before any drafting step runs, so SC-007 is measured
as the absence of drafting cost on those tickets, not as a flag someone set afterwards.

**Rationale**: FR-010 blocks by category precisely so that no amount of evidence quality changes the
answer. Running the drafting step first and discarding the result would spend budget on an outcome
that was determined before the model was called, and it would put generated text about a refund into
storage.

## R-05 · Blocked topics and the allowlist are two different lists, and only one is tenant-owned

**Decision**: the **blocked set** — money, billing, refunds, account mutation, authentication and
access, legal, compliance, security, personal data — is product-level, versioned, and not reducible
by tenant configuration; an attempt to allowlist a blocked category is rejected by the same ceiling
mechanism that forbids direct sending (002 FR-008, FR-010). The **allowlist** is per tenant, starts
empty, and is additive only within what is not blocked (FR-011). Ambiguous or multi-candidate
classification: any blocked candidate wins, and an unclassified issue is treated as not allowlisted.

**Rationale**: a threshold on a money or legal topic is a threshold that eventually gets crossed by a
better-sounding answer. A category block cannot be crossed by rhetoric. Keeping the two lists
separate also stops a tenant's allowlist edit from silently widening the product's risk surface.

## R-06 · Claim decomposition is a separate run from drafting

**Decision**: the drafting agent produces text with typed slots; a second agent run, with its own
prompt key and version (012 FR-038..041), decomposes that text into claims. The decomposer receives
the draft text only — not the drafting run's rationale, tool transcript, self-assessment or
confidence (FR-008). The decomposition is the input to grounding.

**Rationale**: whoever lists the claims decides what gets checked. An agent that drafts and then
decomposes will list the three claims it can defend and quietly omit the fourth, and nothing
downstream can detect the omission because the omitted claim was never named.

**Alternatives**: one call returning text plus claims (cheaper, and the omission is invisible);
deterministic sentence splitting (a sentence is not a claim — one sentence routinely carries two).

## R-07 · Deterministic matching proposes; a model may only reject

**Decision**: grounding runs in two stages. Stage one is deterministic: normalised token and span
matching over the cited `DocumentVersion` text (005 FR-019 pins the version), with exact comparison
for numeric, currency, date and identifier claims, and a lexical-overlap floor for prose claims.
**A claim with no deterministic candidate span is ungrounded — there is no stage that can rescue
it.** Stage two lets a model inspect a proposed span and **reject** it as not actually supporting the
claim. The model can subtract grounding; it cannot add any.

**Rationale**: constitution II — citing is not grounding. A model entailment judge as the primary
matcher has better recall and no floor: it can ground almost anything when the claim is phrased
persuasively, and the failure is silent. Restricting the model to the rejecting direction means the
worst it can do is refuse a good draft, which costs a human review.

**Consequence, accepted**: recall is lower, so more drafts land on `NEEDS_HUMAN`. That is affordable
because Healer never sends and the allowlist starts empty (C-07) — the draft is useful to a human
either way. The overlap floor is configuration tuned in stage 0.

**Alternatives**: model entailment as primary with a deterministic sanity check (the sanity check
becomes advisory within a month); embedding similarity as the matcher (similar is not supporting,
and the failure is exactly the paraphrase that inverts a meaning).

## R-08 · Factual tokens are bound, never generated

**Decision**: the drafting prompt emits placeholders — `{{fact:invoice.amount}}`,
`{{fact:retention.days}}` — and a deterministic binder resolves each to a named structured field
read at draft time, recording source system, value and read timestamp. After binding, a
deterministic scanner walks the **generated** portions of the text for any numeral, date, currency
amount, duration, identifier or SLA-shaped token; finding one rejects the draft. A slot whose field
is unavailable removes the sentence that depends on it and degrades the outcome to `NEEDS_HUMAN`
(FR-012, SC-002).

**Rationale**: FR-012 must hold for tokens nobody thought to pattern-match. Checking numbers after
generation misses "forty euros" and "the third of March" — and those are precisely the ones that
start a refund dispute. Making the number impossible to generate is cheaper than making every
generated number checkable.

**Alternatives**: post-hoc numeric extraction and verification (misses spelled forms, misses
implicit durations); asking the model to cite a field for each number (the model then names the field
it wishes existed).

## R-09 · Commitments are blocked by shape, not by sentiment

**Decision**: a deterministic detector flags future-commitment shapes — a fix date, a credit, a
refund, an exception, a guarantee, a "we will" construction bound to a date or an amount — and
produces `NEEDS_HUMAN` (FR-013). Detection runs on the assembled draft, before the policy decision.

**Rationale**: a promise is the one thing in an answer that creates an obligation rather than
describing one, and no evidence quality makes it safe to make automatically.

## R-10 · Tenant isolation is a signature, not a filter

**Decision**: the retrieval port's methods take a `TenantScope` as a required first argument; no
overload exists without it, and `support` contains no raw SQL (enforced by the same pattern-based
boundary rule family as 012 FR-002/FR-003 — `@prisma/client` and query builders stay in
`infrastructure`). The pgvector search is a parameterised query whose tenant predicate is part of
the index-backed `WHERE`, never a post-filter over a broad result set. Every cited document's tenant
is re-verified at finalisation; a mismatch aborts the answer and raises an incident (FR-014, FR-015).

**Rationale**: a support answer leaves the customer's organisation. "We filter the results" is a
correctness claim about a code path; "there is no method that can return another tenant's rows" is a
property of the type. SC-004 is then testable at the query layer rather than by inspecting output,
which is the only place it is worth testing.

## R-11 · Release is on production verification, and merged does not release

**Decision**: held tickets are released by the `IssueResolved` event with a `resolutionKind`
(001 `contracts/events.md`), which 001 publishes only on verified-in-production. 008's
`PullRequestOpened` does not release. **No merge event releases anything** — 008 publishes none, and
a merge observed in the repository is an inbound fact, not a resolution (008 `contracts/events.md`).
A ticket released this way cites the production verification evidence (FR-018).

**Which `resolutionKind` releases (C-09).** Exactly two: `remediated` — published because 010's
`RemediationVerified` closed a verification window `improved` (010 `contracts/events.md`) — and
`fixed`, published because 008 verified a change in production. Both must arrive with a non-empty
set of verification evidence identifiers; an event of either kind carrying none is treated as a
release failure and escalates. The third kind, `self_resolved`, is a human closing an issue that
stopped happening: it names no verification and therefore **escalates the held tickets** instead of
releasing them. Releasing on it would send fifty customers a draft citing evidence that does not
exist, which is the exact failure FR-018 is written against.

**Rationale**: fifty tickets is the normal case. Releasing on merge tells fifty customers their
problem is fixed while the canary is still running, and every one of those messages is already out of
our hands by the time the rollback happens.

**Note on spec wording**: User Story 8 scenario 2 says "the linked issue reaches a merged state".
There is no `merged` issue state meaning *pull request merged* — 001's `merged` state means two
issues were merged together (001 data model). The condition implemented is: a merged pull request
does not release; only `IssueResolved` does.

## R-12 · The hold is a persisted state with a deadline

**Decision**: `held` carries `held_until` and a `workflow_callback` (012 FR-025..030). Release comes
from the event; expiry comes from the deadline and escalates to a human with what was collected
(FR-020). No job waits, and a held ticket is never indefinitely quiet.

**Rationale**: ADR 0003, and the operational fact that a ticket silently held for three weeks is
worse for the customer relationship than an honest handoff on day two.

## R-13 · A reopened issue invalidates the answers drawn from it

**Decision**: on `IssueReopened` (001 FR-005), every ticket answered from that issue is identified
through `TicketIssueLink` and flagged for human follow-up; the answers are not retracted by Healer,
because Healer did not send them (FR-019).

**Rationale**: the people who were told "this is fixed" are exactly the people who will report it
again. Handing the list to a human is the entire available action, and it is worth having.

## R-14 · Edit and reopen signals are computed deterministically

**Decision**: when a sender reports a send, the reported text is compared to the draft after
normalising whitespace, greeting and signature blocks. The classification is `unedited`,
`cosmetic` (nothing claim-bearing changed) or `material` (a bound fact token, a citation-backed
clause or a negation changed). A reopen inside the configured window is a negative outcome. Both are
stored against the draft's evidence set, model identifier and prompt version (FR-021, 012 FR-033),
and are queryable by tenant, category, model and prompt version for 011 (FR-022).

**Rationale**: this is the cheapest labelled ground truth in the product, produced by work someone
was doing anyway, and it cannot be reconstructed later — if it is not recorded from week one, week
one is gone. A model judging "was this edit meaningful" would put the thing being measured inside
the measurement.

## R-15 · C-07 promotion: consecutive clean sends, counted per category, promoted by a human

**Decision**: `category_eligibility` holds, per `(tenant, category)`: drafts produced, sends
reported, **consecutive** unedited-and-not-reopened sends, and the last reset reason. A category
becomes `promotable` when the consecutive count reaches the configured threshold and no reopen
occurred inside the window. Promotion itself is a recorded human action by a tenant administrator
(actor, timestamp, counter snapshot); the system never promotes. Any `material` edit or any reopen
resets the consecutive counter to zero.

Two consequences stated plainly:

- **Drafts are produced for non-allowlisted categories.** They are attached to a `NEEDS_HUMAN`
  outcome as a proposal for the human handling the ticket, never as an automatic reply. Without them
  there is nothing to measure and the allowlist can never leave empty — C-07 would be
  unimplementable. This resolves a tension in the spec text: FR-011 and User Story 6 scenario 1 say a
  non-allowlisted category yields `NEEDS_HUMAN` "before any answer is drafted", while the Assumptions
  section requires the draft to be produced regardless. The **blocked** set terminates before
  drafting (SC-007); the **non-allowlisted** case drafts and returns `NEEDS_HUMAN`. Spec text should
  be amended to draw that line.
- **A tenant whose sender reports no sends can never promote a category.** That is correct and is
  surfaced as such, rather than substituting a weaker signal.

**Rationale**: C-07. Consecutive rather than cumulative, because a cumulative ratio lets a long good
history hide a recent regression — and the regression is the thing the measurement exists to catch.
Human promotion rather than automatic, because eligibility is a measurement and promotion is a risk
decision, and they belong to different parties.

**Alternatives**: seeding "obviously safe" categories such as password resets (the guess this project
rejected everywhere else); automatic promotion at threshold (makes the measurement into the
decision, and the first bad streak is discovered by a customer).

## R-16 · A machine-generated document cannot alone satisfy "documented behaviour exists"

**Decision**: predicate 6 (`supporting_precedent_exists`) is satisfied by a resolved issue carrying
production verification evidence, or by a cited document whose provenance is `human_authored` or
`machine_generated_human_adopted` (005 FR-007). A `machine_generated` document may be cited with
reduced weight (005 FR-008) but never satisfies the predicate on its own.

**Rationale**: `failure-modes.md` §7. Otherwise Healer answers a customer by quoting a document
Healer wrote, and a year later a growing share of the knowledge base is the model agreeing with
itself.

## R-17 · Citations pin versions, and a stale draft is invalidated rather than released

**Decision**: every citation pins a `DocumentVersion` (005 FR-019). At finalisation the pinned
versions are re-resolved; a changed or deleted version invalidates the draft, which is re-evaluated
from retrieval rather than released. This runs in the same step as the tenant re-verification
(FR-015).

**Rationale**: the window between grounding and release is small but real, and the specific failure —
answering from a document that was corrected in the meantime — is the one the customer will quote
back.

## R-18 · Cross-language answers are an accepted v1 ceiling, and the scanner's language set is declared

**Decision**: the draft is written in the reporter's language; grounding is performed against the
source text in the source's own language, never against a translation (spec edge case). Deterministic
span matching across languages is not available, so a claim whose only support is in another language
has no candidate span and is ungrounded — the outcome is `NEEDS_HUMAN` with the retrieval trace. In
practice v1 reaches `AUTO_REPLY` only when the reporter's language matches the cited source's.

**Declared language set.** The deterministic pieces of the answer path — the generated-token scanner
(R-08), the commitment detector (R-09) and the edit classifier (R-14) — each need a per-language
lexicon: spelled numerals, date and currency forms, duration words, commitment constructions. v1
declares **`en` and `de`**, a product constant and not tenant configuration. A ticket whose detected
`language` is outside the set produces `NEEDS_HUMAN` **before drafting**, the same hard shape as the
cross-language grounding ceiling above (FR-012a). Adding a language is a lexicon, a corpus case and a
release — never a default that falls back to the English lexicon, because a scanner that does not know
"vierzig Euro" reports `clean = true` on exactly the token it exists to catch.

**Corpus consequence**: `make grounding-corpus` carries at least one non-English case per declared
language, and one case in an undeclared language asserting the pre-drafting refusal. Without them
SC-002's "100%" is measured only where the scanner was written.

**Rationale**: grounding against a machine translation grounds the translation, not the source, and
the failure mode is a mistranslated negation reaching a customer. Naming the ceiling is better than
a matcher that quietly succeeds on paraphrase.

## R-19 · The egress gate is an allowlist over the whole monorepo, not a denylist over two packages

**Decision**: `gate-no-send` is a pattern-based build check in the 012 gate family (012 FR-002,
FR-016), and the rule is **inverted**: *no package may import an outbound mail, SMS, chat or generic
HTTP-client module except the packages named in an egress allowlist, and that allowlist contains no
support package.* The only permitted outbound path out of the answer path is the outbox publisher.
The draft-ready event carries the draft, citations, evidence references and the outcome rationale
(FR-016). A send performed elsewhere is recorded as an inbound fact attributed to that actor
(FR-017), never as a Healer action.

**Rationale**: SC-005 requires an egress audit that fails the build if a transport is introduced, and
a rule scoped to `packages/domain/support/**` plus `packages/agents/support/**` does not deliver it.
009's adapters live in `packages/integrations/**` by design (plan.md "Structure decision"), so a new
`packages/integrations/support-send` consuming `SupportAnswerDrafted` from the outbox would send
customer text and trip no gate — the one code path SC-005 names, invisible to the check written for
it. A denylist over the packages we remembered is the shape of that failure; an allowlist over the
whole monorepo means a new sending package has to be *added to the allowlist* by a reviewer, which is
the conversation the gate exists to force. A policy rule would instead be evaluated at runtime by
code that would already hold the transport.

**Cross-spec**: 012 must register `gate-no-send` in `contracts/make-targets.md` and own the allowlist
alongside its other boundary patterns; this spec supplies the rule and the assertion that no support
package is on the list.

## R-20 · No consumer is a visible queue, not a silent drop

**Decision**: a tenant with no external sender configured accumulates draft-ready events in the
outbox with a growing unconsumed depth, which is monitored and surfaced. Nothing is discarded
(001 FR-019).

**Rationale**: the spec edge case, and the general rule that a silently stuck consumer looks exactly
like a quiet system.

## R-21 · Budget exhaustion produces a handoff, never a thinner answer

**Decision**: on budget exhaustion or the declared degradation order reaching its floor
(002 FR-011, FR-012), the outcome is `NEEDS_HUMAN` carrying what was collected. The degradation order
may reduce retrieval depth or model tier for the *draft*, but it may never relax a predicate — a
cheaper run still has to pass all eight or it is not an `AUTO_REPLY` (FR-025).

**Rationale**: degrading the answer is the failure mode the budget exists to prevent. A shorter
answer with less context is indistinguishable in the customer's inbox from a well-grounded one.

## R-22 · Reporter identity is a reference

**Decision**: `SupportTicket` stores a reporter reference (channel-scoped external identifier) and
the text the reporter wrote as a bounded excerpt. No name, address, account record or contact detail
is copied into evidence, drafts or the feedback corpus.

**Rationale**: the feedback corpus is retained for 011 and read by support engineers. Personal data
in it converts a useful training set into a deletion obligation.

## R-23 · `category_eligibility.threshold` is a product constant a tenant may only raise

**Decision**: the consecutive-clean-send threshold for promoting a category defaults to a product
constant of **10**, and a tenant may raise it but never lower it. The floor is enforced the same way as
002's ceiling: a check constraint and a clamp.

**Rationale**: C-07 promotes a category on measured evidence, and the measurement is only as good as
the count behind it. A lowerable threshold is lowered by whoever wants the category promoted, which is
the pressure the threshold exists to resist. Raising is always safe, so raising is allowed.

## R-24 · `human_verdict` is a quality signal for 011 and does **not** touch the C-07 counter

**Decision**: `human_verdict` — the reviewer's opinion of a draft (`useful` · `partly_useful` ·
`not_useful`) — feeds 011's evaluation corpus only. It never advances or resets the consecutive-clean
counter. Only a **send** advances it, and only a material edit or a reopen resets it.

**Rationale**: an opinion and a send are different facts. A reviewer may find a draft useful and still
rewrite half of it; a draft may be sent verbatim by someone who did not read it carefully. C-07 promotes
on behaviour, not on approval, because behaviour is the harder signal to give carelessly.

## R-25 · `sent_edited` is resolved server-side into cosmetic or material

**Decision**: the API accepts `sent_edited` with the sent text. The server diffs it against the draft
and classifies the edit as `sent_cosmetic_edit` or `sent_material_edit` — cosmetic means whitespace,
greeting, sign-off and punctuation only; anything touching a bound fact slot, a citation, a claim or a
negation is material. Only material resets the counter.

The contract keeps one inbound value because the sender cannot be trusted to classify its own edit —
and would not want to, since material resets progress.

**Rationale**: the openapi/data-model divergence the tasks found is resolved in the direction that
removes the incentive problem. Classification is deterministic and its ruleset is versioned, so a
promotion can be explained months later.

## R-26 · Predicate 2 reads a named 005 configuration key, and the starting value is cited

**Decision**: `citations_resolve_trusted_fresh` (predicate 2) reads two named 005 configuration keys
rather than an unnamed "floor":

| Key | Owner | Meaning | Starting value |
|-----|-------|---------|----------------|
| `knowledge.answer_trust_floor` | 005, per tenant | the minimum `trust_tier_rule` tier, for the question type *"what should the system do"*, that a citation may carry and still count | tier 2 — `human_authored` acceptance material and above; `machine_generated` is below it |
| `knowledge.freshness_window[source_class]` | 005, per tenant, per source class | the age at which `freshness_state` becomes `stale` | repository markdown 180 days; resolved-issue evidence unbounded (git and evidence carry their own timestamps) |

A citation whose tier is below the floor, or whose `freshness_state` is `stale` or `unknown`, fails
the predicate; the outcome is `INSUFFICIENT_CONTEXT`. Both values are per-tenant configuration with
the starting values above, tracked in [S0-7](../../docs/stage-0.md) under 009 — "predicate 2 trust
floor, freshness windows" — so they are a measured commitment rather than a phrase.

**Rationale**: the predicate was written against a floor that no artefact defined, which makes it
unimplementable and untestable at the same time: T029 would read whatever 005 happened to expose, and
a floor of zero would pass everything while the predicate still reported true. Naming the key moves
the value to its owner and leaves 009 with a predicate over a configured number.

**Cross-spec**: 005 must add `answer_trust_floor` and the per-source-class `freshness_window` as
tenant configuration alongside `trust_tier_rule`, and expose both on the retrieval result so the
predicate is evaluated over what 005 resolved rather than recomputed here.

## R-27 · `citation.claim_id` is written by deterministic retrieval binding, never by an agent

**Decision**: `citation.claim_id` binds a claim to the document that grounding will search, so the
step that writes it chooses what gets checked. It is written by the **deterministic retrieval
binding** step: after decomposition (R-06), the binder matches each claim against the retrieval
result set by the same normalised token and span logic the grounding matcher uses (R-07), and records
the candidates it found. No agent output field maps to `claim_id`, and the drafting and decomposer
run schemas contain no citation-selection field at all.

**Rationale**: if a drafting or decomposing agent set `claim_id`, a model would be choosing which
document is searched per claim — and the cheapest way to pass grounding is to point each claim at the
document most likely to contain a matching span. That is the R-06 omission problem one level down,
and it is undetectable downstream because the binding looks like a fact. A deterministic binder can
be wrong, but it cannot be strategically wrong.

**Verification**: a test asserts that no field of any agent output schema in this feature maps to
`citation.claim_id`, in the same shape as the "no confidence field" assertion (T031).

## R-28 · Answer publication takes a capability, per ADR 0008

**Decision**: publishing the draft-ready event — the one irreversible step in this feature, because a
consumer may send from it — takes an `AnswerPublishCapability` argument and can resolve one from
nowhere else: not the DI container, not a module import, not ambient configuration, not a global
([ADR 0008](../../docs/adr/0008-capability-passing.md), FR-016). The support agent bundle does not
contain it; a simulation bundle contains none of the four capabilities at all (011 R-01).

**Rationale**: ADR 0008 lists support answer publication as one of the four operations in scope, and
the word appeared nowhere in this spec. "Healer never sends" is enforced upstream by `gate-no-send`
(R-19) removing the transport; the capability is what stops the *publication* being reachable from a
run that was never granted it — including a simulation run replaying a support ticket.

## R-29 · Intake asks for the failing request, because it collapses the expensive path

**Decision**: intake attempts to capture, from the reporting system, a **trace identifier**, a HAR
entry or a browser console log alongside the report. Where one is present it is recorded as evidence
and referenced by the reproduction directive.

**Rationale**: a client-observable symptom still reaches 007's `client_request` rung — no browser —
whenever the failing request is known. Without it, reproduction climbs to `client_journey`, which needs
the customer's frontend build, browsers in the runner image and a locally served application: the most
expensive operation in the product (007 R-23). **Asking the reporter's system one question is the
cheapest cost control in the entire reproduction path**, and it costs nothing at answer time.

Absence is not a failure. It is recorded as a `collection_gap`, and reproduction proceeds on the
client ladder from its cheapest rung as normal.

**Alternatives**: asking the human reporter for a trace id (they do not have one, and asking makes the
support interaction worse); always going to the browser (pays minutes and flakiness for information
the reporting system already held).

## Unresolved

None.
