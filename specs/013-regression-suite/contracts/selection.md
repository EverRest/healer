# Contract: test selection for a pull request

The only synchronous call the customer's CI makes to Healer. It exists to make running the regression
suite on every pull request affordable, and it is shaped so that its failure costs time, never
coverage.

## The CI step

Runs before the test job in the customer's pipeline, with a tenant-scoped CI credential.

```text
input   repository, base commit, head commit, changed paths (repository-relative)
call    POST /api/v1/regression/selection   (timeout declared by the step, default 10 s)
output  a file listing test identifiers for the test job, or the literal FULL_SUITE
```

| Situation | Step output |
|-----------|-------------|
| Healer answers | the returned test identifiers, or `FULL_SUITE` if Healer returned `fullSuite: true` |
| Healer unreachable, times out, or answers with an error | `FULL_SUITE`, and the reason printed in the job log |
| No bound tests in the closure | an empty list — the suite has nothing to say about this change; the customer's own tests still run |

**Selection may widen, never narrow.** There is no response and no failure mode in which the step
selects fewer tests than the closure implies.

## Request and response

See [openapi.yaml](openapi.yaml). What crosses: commits and repository-relative paths inbound, test
identifiers and paths outbound. No file contents in either direction (012 FR-022).

## Semantics

1. Map each changed path to its component through 004's repository mapping. A path mapping to no
   component → `fullSuite: true`, reason `unknown_path`.
2. Compute 004's impact closure of those components. Uncomputable → `fullSuite: true`, reason
   `closure_uncomputable`.
3. Select every `active` binding whose component is in the closure, plus every binding whose `flow`
   passes through a component in the closure (C-28).
4. Record a `selection_request` row, whichever branch was taken.
