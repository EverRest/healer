# Product thesis

## The claim

> Quality comes from the loop, not from the model.

Any frontier model can propose a plausible patch for a stack trace. What none of them can do alone
is prove the patch fixed the reported problem rather than masking it, and prove nothing else broke.
Healer's value is the surrounding machinery — evidence, expectation, reproduction, independent
verification, policy — not the generation step in the middle.

This has a consequence that shapes the whole product: **the model is replaceable, the loop is not.**
If a better model appears, Healer swaps an adapter. If a competitor has a better model but no loop,
they ship confident wrong fixes faster than we do.

## Why the loop is the hard part

The obvious pipeline `error → LLM → patch → merge` fails not because the patch is bad, but because
nothing in it can distinguish these two outcomes:

```text
symptom gone, cause fixed      ← what we want
symptom gone, cause masked     ← indistinguishable without an independent expectation
```

A try/catch around the failing call makes the alert stop firing. Tests pass. Error rate drops.
Every signal says success. The bug is still there and is now invisible.

Distinguishing them needs something the system did not derive from its own diagnosis: what the
behaviour was supposed to be. That is the whole reason `ExpectedBehavior` exists as an entity,
and why product knowledge is a runtime dependency rather than documentation.

## What Healer actually sells

Not "AI fixes your bugs". At L2 the honest pitch is:

> Every incident arrives with the context already gathered, the change correlation already done,
> a root-cause hypothesis with the evidence behind it, and a reproduction if one exists.

The engineer still decides. What disappears is the thirty minutes of grepping logs, checking what
deployed, and reading the runbook — repeated by a different person at 3am every time.

Code changes are the upsell to an account that already believes the diagnoses.

**The regression suite is the second way in.** Incidents arrive when something breaks; the suite
arrives with every pull request. It turns the same adopted expectations into tests, runs them in the
customer's CI, and sends a default-branch failure into the same pipeline as an alert — already carrying
the anchor a fix needs (013). It is also the cheapest thing to trust: a test pull request changes no
behaviour, and a human merges it.

## Why now

Three things are true simultaneously that were not a few years ago: models can hold a large enough
context to reason across logs, traces and a codebase at once; observability is standardised enough
(OpenTelemetry) that evidence collection is an adapter problem rather than a research problem; and
teams already accept AI-authored pull requests as a normal review workload.

The last one matters most — it means L2 output lands in an existing habit instead of requiring a
new one.

## What would make this fail

- **Reproducibility is lower than assumed.** If most production incidents cannot be reproduced in
  a sandbox, the TDD half of the product has nothing to stand on. See [incident-taxonomy](incident-taxonomy.md).
- **Product knowledge never gets written.** Without adopted expectations, verification collapses
  back to "tests pass", which is the failure mode above. See [knowledge-model](knowledge-model.md).
  The regression suite is the mitigation that pays daily rather than per incident (013).
- **One highly visible wrong fix.** Trust in this category is asymmetric: a hundred good diagnoses
  do not offset one bad merge. This is why the autonomy ladder is per component and per action.
