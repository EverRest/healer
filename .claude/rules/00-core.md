# Healer — always-on rules

- The main playbook is `AGENTS.md` (imported into `CLAUDE.md`). The principles are in `.specify/memory/constitution.md`.
- Flow: understand (spec + docs) → plan → test (TDD) → implement → verify (`make ci`).
- Evidence or silence: make no claim without an evidence record. The producing step emits the links.
- Never verify against an artifact that an earlier step in the same chain produced (constitution II).
- Reproduce before you modify. `INCONCLUSIVE` is a valid result.
- Model confidence is never a gate predicate. Policy is deterministic. Nothing can override it.
- Every query carries `tenantId` from the auth context.
- Never wait inside a job. Use a persisted state and an inbound callback.
- A new dependency or pattern needs an ADR in `docs/adr/` first.
- Make the unsafe state unrepresentable. Do not only check for it (`docs/patterns.md`).
- A closed list has exactly one authority. The requirement that governs the list does not repeat its members.
- Every guarantee names the mechanism that **refuses to continue** without it. A mechanism that is
  correct, cannot be forged and is on nobody's decision path is not a control. "A reviewer would
  notice" is not a reader.
- Never measure a number on the data that you tuned it on. This is most important when the number gates autonomy.
- If two specs use a term differently, that is a defect. Check `docs/domain/glossary.md`.
