# ADR 0009: Derivation artifacts, and gating a diff rather than data

## Status

Accepted — 2026-09-24

## Context

The four thresholds that govern autonomy are derived facts, and 011 makes them unforgeable: a
`threshold_derivation` row cannot be inserted citing a synthetic, partial, unrepeatable or tuning-set run,
enforced by a composite foreign key and five check constraints rather than by validation.

The ceiling those thresholds govern is `ACTION_CEILING`, a pure function of action class and undo
attestation. In this release it gives `merge`, `forward_deploy` and `irreversible` **no level at all**, and
that absence is the whole of what holds Healer at L2.

`gate-ceiling` enforced the ceiling **against data**: no `autonomy_grant` row may exceed it. Nothing looked
at the function. A pull request giving `merge` a level therefore passed every gate in the repository, and
the product's central claim — autonomy is earned by measurement — rested at the decisive moment on a code
review.

Two options were available and both were wrong:

- **Make the ceiling read a threshold at runtime.** This puts a database value on the permission path. A
  value that is read can be misconfigured, cached stale, or fail open during an outage, and the ceiling's
  entire strength is that it is a literal in code.
- **Require a constitution amendment for a raise.** Already true, and it is the same human review that
  would approve the diff. A process is not a mechanism.

## Decision

**Gate the edit, not the evaluation.** A diff that raises a level in `ACTION_CEILING` must cite a
derivation, and `gate-ceiling` gains a third assertion that resolves it. The evaluation path gains no
branch and no configuration input.

**Resolve the citation from a committed artifact, not from the database.** Publishing a derivation also
writes a self-contained file under `docs/derivations/` — threshold key, value, run id, dataset version,
metric, scored real denominator and the four run facts — and records its digest on the row.

```text
control plane                       repository                      build
threshold_derivation row  ──export──▶ docs/derivations/<run>.json ──▶ gate-ceiling resolves it
        ▲                                     │
        └──────── continuous reconciliation ───┘   both directions
```

**The row remains the authority.** The artifact is provenance. A file can be hand-written; a row cannot,
because of the constraints around it. So the two are reconciled continuously in both directions — an
artifact with no row, a row in effect with no artifact, or a digest that disagrees is a failure.

## Consequences

- \+ The claim "autonomy is earned by measurement" becomes checkable by anyone with the repository, which
  is also the strongest version of it to say to a customer.
- \+ The gate needs no control-plane credentials and cannot fail on a database outage — a gate that turns
  into noise during an incident is a gate somebody disables.
- \+ The pattern generalises: any control-plane fact a build must check can cross as a committed artifact
  with reconciliation, instead of by giving continuous integration a production connection.
- − Two artifacts for one fact, which is duplication accepted deliberately and paid for by the
  reconciliation check. Without it this would be a cache that silently diverges.
- − Publishing a derivation now involves a commit, so raising a ceiling is at least two changes. That
  friction is the point.
- − A determined operator with repository write can still write both a row and an artifact. Nothing here
  defends against the person who owns the control plane; it defends against the ordinary path, where a
  raise looks like a small, reasonable pull request.

## Alternatives rejected

- **Gate on the database from CI** — credentials in the build pipeline to check a compliance fact, and an
  outage becomes a build failure indistinguishable from a violation.
- **Sign the artifact** — solves a threat that is not the one here. The concern is a plausible pull request,
  not a forger; reconciliation against the row already catches the hand-written file.
- **Store the ceiling in the database** — see Context. It would make the permission path readable, which is
  exactly what the literal-in-code design refuses.
