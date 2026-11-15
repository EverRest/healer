# B-series — the rest of the project, in file-disjoint batches

Written 2026-11-15 (state: VERSION 0.56.1, 298 of ≈1 236 tasks done). Extends A1–A3; uses `_shared-block.md` for setup, reading list, lessons and models, with the three overrides below.

## Overrides of `_shared-block.md`
1. **Worktree per batch, and per sub-batch.** `EnterWorktree` name = batch id (`b1-010-catalogue`). Sub-batches that share no file get their own worktree. Never work in the main checkout.
2. **TDD is enforced.** Invoke `superpowers:test-driven-development`. Each task: red test first (watch it fail for the right reason), then code, then refactor. `gate-red-first` must stay green.
3. **Final review = `superpowers:requesting-code-review`**, run once on the finished batch branch against `origin/master` (replaces the pr-review-toolkit pair). Fix every Critical/Important finding, then `superpowers:verification-before-completion` (`make ci` evidence) before any "done".
4. **Git:** commit on the batch branch only. Do not merge to master, push, or add a `Co-Authored-By` trailer without Pavlo's word (global rule beats shared-block §11). Stop at "branch green, review clean".

## Ownership matrix (a batch edits only what it owns)
| Batch | Owns (dirs) | Migration range | Starts when |
|---|---|---|---|
| B1 010 phases 1–3 (catalogue) | `packages/domain/remediation`, `specs/010-*` | `20261020*` | now |
| B2 011 phases 1–3 (eval foundation, safe sim) | `packages/domain/evaluation`, `packages/shared/capabilities` (new), `specs/011-*` | `20261030*` | now |
| B3 007 phases 1–2, 6 (sandbox) | `packages/sandbox`, `packages/domain/reproduction`, `specs/007-*` | `20261040*` | now |
| B4 012 llm/secrets (T066–T068, T095) | `packages/llm`, `packages/prompts`, `packages/shared/config`, `docs/adr/0019-*` (secret manager), `docs/runbooks/provider-key-rotation.md` | none | now |
| B5 012 agent tooling (T088, T089, T091, T092, T099, T100, T104) | `.github/**`, `scripts/agent/**`, `docs/runbooks/chat-channel.md`, `AGENTS.md` | none | now |
| B6 004 phase 8 (product layer, polish) | `packages/domain/architecture`, `apps/api/src/graph` | `20261050*` | after `004-phase6-7` is on master |
| B7 006 phases 1–3 | `packages/domain/diagnosis`, `packages/agents/investigator` | `20261060*` | after A3 and B4 |
| B8 008 phases 1–4 (impact, declared change) | `packages/code-intelligence`, `packages/domain/change` | `20261070*` | after B6 |
| B9 010 phases 4–6 (runner side, dry-run, rollback) | `apps/runner/src/remediation/**` (new dir only), `packages/domain/remediation` | `20261080*` | after B1 and `worktree-012-inference-capability` |
| B10 009 phases 1–5 | `packages/domain/support`, `packages/agents/support`, `packages/integrations/support-send` | `20261090*` | after B7 |
| B11 011 phases 4–8 | `packages/domain/evaluation` | `20261100*` | after B2 and B7 |
| B12 005 phases 5–9 | `packages/domain/knowledge`, `packages/integrations/openapi` | `20261110*` | after A3 |
| B13 002 phase 5 rest (T048–T053, T058b, T066b, T082) | `packages/domain/policy` | none | after B1 and B7 |
| B14 007 phases 3–5, 7–9, 12 | `packages/domain/reproduction`, `packages/sandbox` | `20261120*` | after B3 and B7 |
| B15 006 phases 4–12 | `packages/domain/diagnosis`, `packages/agents/investigator` | `20261130*` | after B7 |
| B16 008 phases 5–13 | `packages/agents/{change,verifier}`, `packages/domain/change` | `20261140*` | after B8, B14, B15 |
| B17 009 phases 6–13, 010 phases 7–11 | split in two worktrees, dirs as above | `20261150*`, `20261160*` | after B10, B9, B13 |
| B18 013 (all) | `packages/domain/regression`, `packages/agents/test-author` | `20261170*` | after B12, B16 |
| B19 release | quickstart runs (001 T056, 002 T081, 003 T096, 004 T088, 012 T073), `make eval`, `docs/roadmap.md` | none | last |

Already running and not touched by any B batch: A1 (002 phase 5 rate limits), A2 (003 phases 5–7), A3 (005 phases 3–4), `003-context-phase4`, `004-phase6-7-blast-radius-drift`, `final-005b`, `worktree-012-inference-capability` (`packages/domain/policy` 6 files, `boundary-contract`, `apps/runner`).

## Waves (batches in a wave run in parallel)
- **Wave 1:** B1–B5 (+ the running A-batches). All dirs disjoint.
- **Wave 2:** B6, B7, B8, B9, B12 as preconditions land.
- **Wave 3:** B10, B11, B13, B14, B15.
- **Wave 4:** B16, B17, B18, then B19.

## Shared hot files — the only places batches can collide
| File | Rule |
|---|---|
| `prisma/schema.prisma` | add a fenced block `// ── B<n> ──` at the end of the batch's own schema section; never reorder or edit another block |
| `prisma/migrations/` | only the batch's reserved range; every migration has `down.sql`; re-run `ls` after `git fetch` |
| `apps/api/src/main.ts`, `createApiModule` | one added line per controller/provider group, in a block commented `// B<n>`; check every e2e call site that boots the app (lesson from 0.47.0) |
| `apps/api/openapi.json` | never hand-edit; `pnpm run contracts-generate` after rebase |
| `vitest.config.ts` (`HEAVY_E2E`) | append only |
| `packages/boundary-contract` | new shapes in new files; edit `index.ts` by appending one export line; a change to an existing shape needs Pavlo |
| `QUESTIONS.md`, `tasks.md` | own section / own spec only; on rebase conflict keep both sides |
| `VERSION`, `docs/changelog.md` | not touched by a batch; the integrator bumps once per merge |

## Per-batch recipe (the orchestrator follows this)
1. Setup per `_shared-block.md` §2, in a new worktree; confirm the "starts when" precondition with `git log master` and stop if it is not met.
2. Read: spec, plan, research, data-model, quickstart, tasks, contracts, plus ADRs and QUESTIONS sections naming this spec.
3. From `tasks.md`, list the exact files each sub-batch will touch; if two sub-batches share one, serialise them.
4. Per sub-batch (Sonnet implementer, own worktree): TDD, mutation-check each guard, tenant-isolation e2e for every endpoint, spec `data-model.md` updated with any schema change.
5. After the last sub-batch: `make ci` in the batch worktree, then `superpowers:requesting-code-review`, fix, re-verify.
6. Report per `_shared-block.md` §12, plus: files touched outside the ownership table.

## Not codeable — Pavlo or a human
S0-1 incident-history audit (blocks the benchmark and every threshold); GitHub App, branch-protection ruleset and `CODEOWNERS` (012 T090); a real authentication system (today `X-Actor-Id` is a header); runner image registry and hosting; choice of the secret manager (B4 records an ADR proposal, not a decision). B19's `make eval` cannot produce thresholds without S0-1.
