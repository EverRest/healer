# Contract: test-runner adapter

What a new stack's adapter implements. The v1 adapter set covers one stack (constitution VII); this
contract is what makes the second one a package rather than a branch in the engine.

**The rule this contract exists for**: an adapter never parses human-readable output. It injects a
machine-readable reporter and reads the report file. Every unparseable output that degrades to
"looks fine" is a false `PASS`, and a false `PASS` opens the change path on a defect that was never
reproduced — the most expensive lie this system can tell (research R-10).

## Three steps, three records

Discovery, invocation and parsing are separate and each records its outcome. Collapsing them hides
which one failed, and they fail for different reasons and route differently.

```text
discover(repositoryRoot)  → AdapterResolution | unsupported
invoke(resolution, selector) → { exitCode, reportPresent, durations, resourceUsage }
parse(reportPath, format) → TestResult[] | unparseable
```

## Discovery

```jsonc
{
  "adapterKey": "vitest",
  "detection": ["vitest.config.ts", "package.json:devDependencies.vitest"],
  "command": "npx vitest run --reporter=junit --outputFile={reportPath} {selector}",
  "workingDirectory": "packages/api",
  "reportFormat": "junit_xml",       // junit_xml | runner_json
  "reportPath": "/workspace/.healer/report.xml"
}
```

Requirements:

- **Detection is file-based and deterministic.** No model participates in deciding which adapter
  applies; two runs over the same tree resolve identically.
- **The command template must inject a machine-readable reporter flag.** An adapter that cannot
  obtain a structured report from its runner declares the repository `unsupported`. It does not fall
  back to parsing stdout.
- `reportPath` is inside the workspace, so it dies with it.
- The resolution is recorded per execution (`runner_adapter_resolution`) — the command actually run,
  not the template.

### When no adapter matches

1. Use the tenant-declared test command from configuration (FR-020). It must also declare a
   `reportPath` and a `reportFormat`; a tenant command without one is treated as unsupported.
2. Absent that, the result is `INCONCLUSIVE` with reason `no_test_command`, naming the missing
   configuration. Never `PASS`, and never a guess.

## Invocation

- Runs inside the sandbox only (FR-009). The adapter has no network — the run container has no
  default route (research R-08).
- Accepts a selector: a targeted subset (a file, a test id pattern) or the whole unit scope. Full
  suite and e2e are not invoked here; they are delegated to the customer's CI (FR-021, D-16).
- Wall clock, CPU, memory, process count, open files and disk come from the run's
  `sandbox_profile` version. A breach kills the entire process tree (FR-010).
- The adapter reports `exitCode` and `reportPresent` separately. They are different facts:

| exitCode | reportPresent | Recorded as |
|----------|---------------|-------------|
| 0 | true | parsed results; all passing |
| non-zero | true | parsed results with failures — a **test** failure |
| non-zero | false | `unparseable_output` → `INCONCLUSIVE`; distinguished from parsed failures (FR-020 edge case) |
| any | false, and the build never completed | `build_failure` → `INCONCLUSIVE`, build output attached (FR-017) |

## Parsing

Produces `TestResult` rows:

```jsonc
{
  "testId": "packages/api/src/orders/create.spec.ts::creates one order per idempotency key",
  "filePath": "packages/api/src/orders/create.spec.ts",
  "status": "failed",                 // passed | failed | skipped | errored
  "durationMs": 12,
  "failureMessage": "…",              // bounded at capture (001 FR-011)
  "failureSignature": { "…": "normalised, for the equality check in ladder.md" }
}
```

Requirements:

- A report that is present but malformed is `unparseable`, not "zero tests". Zero parsed tests with
  a present, well-formed report is a valid and different result — it means the selector matched
  nothing, which is itself `INCONCLUSIVE` rather than `PASS`.
- `failureSignature` is normalised by the **issue's** `normalisation_ruleset` version, so the
  equality check in [ladder.md](ladder.md) compares like with like.
- `failureMessage` is bounded at capture and never crosses the boundary in full; what crosses is the
  `test_result` shape (012 FR-022).

## What an adapter must not do

- Parse human-readable stdout, in any fallback, for any runner.
- Return `PASS` for anything it could not read. Absence of evidence is `INCONCLUSIVE`.
- Reach the network, the control plane, or any path outside the workspace and the read-only
  dependency cache.
- Retry a failing run and report the passing attempt. A retry is a new execution identifier and
  results never merge (FR-013, research R-13).
- Hold a credential. The sandbox contains none (FR-012).

## Conformance

A new adapter ships with a fixture repository exercising, at minimum:

| # | Fixture | Expected |
|---|---------|----------|
| 1 | all tests pass | parsed, all `passed`, exit 0 |
| 2 | one test fails | parsed, one `failed`, exit non-zero |
| 3 | the build is broken | `build_failure` → `INCONCLUSIVE`, build output as evidence |
| 4 | the reporter writes nothing | `unparseable_output` → `INCONCLUSIVE`, never `PASS` |
| 5 | the report is truncated mid-file | `unparseable`, not "zero tests" |
| 6 | the selector matches nothing | zero results, `INCONCLUSIVE`, never `PASS` |
| 7 | a test hangs | wall-clock kill of the process tree, `TIMEOUT` → `INCONCLUSIVE` |
| 8 | a test attempts egress | denied, recorded on the run, run continues |

`make ci` runs the conformance suite for every registered adapter. An adapter without one is not
registered.
