@AGENTS.md

## Claude Code

This file is the Claude Code entry point. Canonical rules live in `AGENTS.md` (imported above);
principles in [.specify/memory/constitution.md](.specify/memory/constitution.md).

### Before non-trivial work

1. Read the feature spec (`specs/<NNN>/spec.md`, then `plan.md`), then the related `docs/` — that
   is the specification, not background.
2. Find a similar handler or agent and follow the pattern; check `docs/adr/`.
3. Plan the smallest correct diff; TDD is the normal way to write behaviour, not the exception.
4. Several reasonable options or an ambiguous requirement — propose and ask, do not guess.

### Rules in `.claude/rules/`

| File | Covers |
|------|--------|
| `00-core.md` | Workflow, inviolable rules |
| `backend-nestjs.md` | Modules, CQRS, forbidden imports, lint limits |
| `agents-and-llm.md` | Agent boundaries, prompts, structured output, cost |
| `evidence-and-policy.md` | Evidence records, anchors, policy enforcement |
| `security-and-tenancy.md` | Tenant isolation, sandbox, untrusted input |
| `prisma-migrations.md` | Schemas, tenantId, migrations |

### Boundaries

- Do not commit or push without an explicit request.
- Do not read or print `.env`, keys, certificates.
- Customer source, logs and secrets never leave the execution plane except as structured evidence.
- Documentation and identifiers are English.
