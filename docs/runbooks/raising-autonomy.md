# Runbook: raising an autonomy ceiling

**When this is used:** a level is to be granted to an action class that has none, or an existing level
raised. In the current release that means giving `merge` a level — which is the single change that moves
Healer off L2.

**Who can do it:** whoever can merge to the default branch. The gate does not check identity; it checks that
the measurement exists. That is deliberate — an identity check is bypassed by asking someone else, and a
missing measurement cannot be.

**What this is not:** granting autonomy *to a tenant* within the existing ceiling. That is an
`autonomy_grant` row, an ordinary product operation, scoped per component and environment, revocable in one
action. Nothing here applies to it.

## The order matters

Each step exists because the one before it can be faked without it.

### 1. Establish that the measurement can exist at all

```text
the benchmark set holds ≥ 20 real, adjudicated, runnable incidents
                       with split = 'benchmark'
```

`dev` entries do not count and synthetic entries do not count. If the number is not there, stop: no
threshold exists, and the ceiling holds by design rather than by omission (C-05, C-29). Adding entries to
reach twenty is legitimate; changing an entry's split to reach twenty is not, and the database refuses it.

### 2. Run the benchmark against the sealed split

```bash
make eval        # release gate, deliberately outside make ci
```

The run must finish `complete` and `reproducible`, and its `split_scope` must come back `benchmark`. All
three are computed, not declared. A run that suspended on budget is `partial` and justifies nothing — resume
it and let it finish rather than deriving from what completed.

### 3. Derive the threshold

The derivation is refused unless the run was complete, repeatable, free of synthetic material, scoped to
`benchmark`, and the scored real denominator for the cited metric reaches twenty. These are check
constraints on the row, so the refusal also holds for a direct SQL insert.

If it is refused, read the reason before changing anything. Every refusal here names a fact about the run,
and the fix is a better run, never a smaller constraint.

### 4. Export the artifact and commit it

Publishing the derivation writes a file under `docs/derivations/`:

```text
docs/derivations/<run-id>.json
  thresholdKey            one of the four
  value
  runId, datasetVersionId, metric
  realDenominator         the scored real denominator, not the dataset size
  runSyntheticScoredCount runCompletionState  runReproducibility  runSplitScope
  artifactDigest          matches threshold_derivation.artifact_digest
```

Commit it. The build resolves this file; it has no database access (ADR 0009).

### 5. Raise the ceiling, citing the artifact

Edit the level table in `ACTION_CEILING` and cite the derivation in the change. `gate-ceiling` fails when
a raise cites nothing, cites something it cannot resolve, or cites an artifact whose digest disagrees with
its row. It fails closed: unresolvable means refused.

Do **not** add a configuration input to the ceiling to make this easier. The ceiling is a literal in code
precisely so that raising it is visible in a diff, and the gate exists because a diff is the only place the
raise is visible at all.

### 6. Amend the constitution

The autonomy ceiling is constitutional text. A raise is a MINOR amendment with a Sync Impact Report, and
the specs whose FRs assume the old ceiling — 002 FR-008, 008 FR-024 — are updated in the same change.

## When it is refused

| Refusal | What it actually means | What not to do |
|---|---|---|
| Fewer than 20 in the denominator | The run scored fewer real benchmark incidents than the product constant allows | Lower `min_real_yield`. It is a literal in the migration and a constant in code, with a test that they agree, because a lowerable minimum is lowered by whoever wants the threshold |
| `split_scope = 'mixed'` | The run scored tuning material | Re-mark the entries. The split is never updated; a reclassification is a new entry |
| `run_completion_state = 'partial'` | The run suspended, probably on budget | Derive from the part that finished |
| Digest mismatch | The committed artifact and the row disagree | Edit the artifact. Re-export it |
| Gate cannot resolve the citation | Usually a missing commit | Skip the gate. It fails closed for the same reason every other gate does |

## Why it is this heavy

A hundred correct diagnoses do not offset one bad merge, so the number that permits merging is the most
consequential number in the product. Every step above removes one way of arriving at that number without
having earned it — and the most likely way, by a wide margin, is not malice. It is a reasonable engineer
under delivery pressure, measuring on the data that was to hand.
