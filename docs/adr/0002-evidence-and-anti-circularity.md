# ADR 0002: Evidence as substrate, and verification that cannot close a circle

## Status

Accepted — 2026-09-23

## Context

The failure mode of this product is a confident wrong answer that passes every gate. Design review
found the same structural flaw in three places: the regression test verified against the diagnosis
that wrote it; answer citations against the answer that chose them; the adversarial reviewer
against "the reported root cause", which is the first model's conclusion.

In each case every gate reports PASS while the system is wrong, and nothing in the output
distinguishes that from success.

## Decision

**Evidence is one immutable substrate.** Timeline, postmortem, audit trail, evidence graph and
change correlation are five views of it, not five subsystems. Links are emitted by the step that
produced them, as it runs — never authored afterwards by a model asked to explain itself.

**No verification step may anchor on an artifact produced by an earlier step in the same chain.**
Anchors are: adopted `ExpectedBehavior`, raw evidence, human-written tests, production signal.

Verifiers ranked by genuine independence:

```text
production signal > human-written tests > expectation-anchored regression test
    > second model > self-review
```

A regression test is valid only if its assertion traces to an `ExpectedBehavior` that existed
before the issue. **A wrong test also fails on the old code** — RED/GREEN alone proves nothing.

## Consequences

- \+ A wrong diagnosis cannot silently produce a "verified" fix.
- \+ Explanations are records rather than stories.
- − `ExpectedBehavior` becomes a hard dependency; without adopted expectations the automated fix
  path is closed and work routes to a human. That is the correct behaviour, but it means the
  knowledge layer is load-bearing rather than optional.
- − Two models reviewing each other is explicitly demoted from "independent verification" to a weak
  signal, which removes a tempting shortcut.
