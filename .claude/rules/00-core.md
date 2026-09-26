# Healer — always-on rules

- Canonical playbook: `AGENTS.md` (imported into `CLAUDE.md`); principles: `.specify/memory/constitution.md`.
- Flow: understand (spec + docs) → plan → test (TDD) → implement → verify (`make ci`).
- Evidence or silence: no claim without an evidence record; links emitted by the producing step.
- Never verify against an artifact produced earlier in the same chain (constitution II).
- Reproduce before modifying; `INCONCLUSIVE` is a valid outcome.
- Model confidence is never a gate predicate; policy is deterministic and cannot be overridden.
- Every query carries `tenantId` from auth context.
- Never wait inside a job — persisted state + inbound callback.
- New dependency or pattern → ADR in `docs/adr/` first.
- Prefer making the unsafe state unrepresentable over checking for it (`docs/patterns.md`).
- A closed list has exactly one authority; the requirement governing it does not restate its members.
- Every guarantee names the mechanism that **refuses to proceed** without it. Correct, unforgeable and on
  nobody's decision path is not a control; "a reviewer would notice" is not a reader.
- Never measure a number on the data it was tuned against, above all when that number gates autonomy.
- A term used differently in two specs is a defect — check `docs/domain/glossary.md`.
