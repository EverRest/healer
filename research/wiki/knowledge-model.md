# Knowledge model

Three kinds of knowledge feed the loop. They differ in where they come from, how much they can be
trusted, and whether they can be generated at all.

## The three graphs

| Graph | Built from | Automatable? |
|---|---|---|
| **Code** | AST, imports, call graph, type graph, tests | Yes — deterministic |
| **Runtime** | Kubernetes, Terraform, OpenTelemetry, deploys | Yes — mostly observed |
| **Product** | Features, user flows, business rules, expected behaviour | **No — human knowledge only** |

This asymmetry is the central fact of the knowledge layer. Two of three graphs are close to free.
The third is the one everything distinctive depends on — product verification, `ExpectedBehavior`,
non-circular regression tests — and it cannot be derived from the system, because the system may
be wrong. That is the entire point of having it.

## Linking the graphs

The hardest technical problem here. What is derivable and what is not:

```text
endpoint → service → datastore      distributed traces      observed, not inferred
route → handler                     OpenAPI / framework metadata
handler → symbols                   AST
symbol → component                  repository layout + ownership
component → deployment unit         runtime adapter
feature → endpoint                  ← NOT derivable; human-confirmed seam
```

Traces are the strongest glue because they are observed reality rather than inference. The one
human seam is small enough to be practical during onboarding.

## Trust inverts by question

A stale wiki is only dangerous if it is treated as authority on current behaviour. It is not.

```text
"What does the system do?"      observed > code > verified incidents > wiki
"What should it do?"            adopted expectations > human tests > code > observed
```

Wiki and code disagreeing is not an error to resolve automatically — it is a `KnowledgeDrift`
issue for a human. Either the wiki is stale or the code is wrong, and only a person knows which.

## Provenance

Every document carries how it came to exist:

| Provenance | May be cited as evidence | May be an `ExpectedBehavior` anchor |
|---|---|---|
| Human-authored | Yes | Yes |
| Machine-generated, human-adopted | Yes | Yes |
| Machine-generated, not adopted | Yes, with lower weight | **No** |

Without the last row, Healer writes its own verification anchors and the independence argument
collapses. See [failure-modes](failure-modes.md) §7.

## Structured over prose

Retrieval over prose gives plausible paragraphs. Machine-readable rules give checkable facts:

```yaml
feature: checkout
expected_behaviors:
  - id: checkout-002
    description: duplicate checkout cannot create duplicate order
constraints:
  max_payment_retries: 3
  inventory_reservation_timeout: 15s
```

Prose stays for humans; the structured block is what a policy predicate can evaluate. A constraint
like `max_payment_retries: 3` turns "the patch changed retry behaviour" from a judgement call into
a comparison.

## Scenarios are expectations

A regression scenario — "applying the same discount twice returns 409 and leaves the total unchanged" —
is not a new kind of knowledge. It is an `ExpectedBehavior` with a subject (an endpoint, a page or a
flow) and a Given/When/Then for the reviewer, in the same markdown file as the rest, adopted the same way:
by a human approving the pull request (013 R-01, 005 R-16). A second store of scenarios would drift from
the expectations within a release, and the drift would be invisible because both would look authoritative.

The Given/When/Then is for people. A test asserts the **constraint**, never the prose.

## Embeddings over customer documents

None in v1 (C-36). An embedding is a model call over a document that does not cross the boundary, and a
vector is derived content that is partly invertible. Retrieval runs on its lexical and structured paths,
which 005 already required to work without a model. Structured front matter is what makes that
sufficient: a constraint is found by key, not by similarity.

## Cold start

A new customer has no product graph. Onboarding seeds drafts from what already exists — OpenAPI
descriptions, e2e test names, acceptance criteria in tickets, and repository markdown — the only text
source in v1, since a hosted wiki has no adapter (C-06) — and a human adopts them. Measured in stage 0 (S0-5): if adoption takes weeks, product verification never works
in practice and the loop degrades to "tests pass".

**Adoption volume is the wrong measure, and it took the stage-0 review to notice.** Three hundred adopted
expectations for a feature nobody breaks change nothing. The quantity that matters is *coverage of the
incidents that actually happen*: after seeding one feature, what share of that feature's historical
incidents would have had an adopted expectation covering them (SC-009a). That share predicts how often
diagnosis records `NO_EXPECTATION` and the automated fix path therefore refuses — which is to say how often
the loop fires at all.

Failure here is not unsafe, it is **silent**: no anchor means no automated fix, by design, and the product
degrades to "we found something, you deal with it". The temptation that follows is to auto-adopt the
obvious expectations, which is the same guess rejected for the AutoSupport allowlist (C-07) and which
converts the product into a machine verifying itself against itself.

**The regression suite changes the incentive, not the rule.** Before 013, an adopted expectation paid off
only when an incident happened to touch it. Now it also becomes a test on the next pull request. That
makes writing product knowledge worth doing for its own sake — the adoption bottleneck is unchanged, but
the reason to clear it arrives every day instead of once per incident.
