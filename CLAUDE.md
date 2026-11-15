@AGENTS.md

## Claude Code

This file is the entry point for Claude Code. The main rules are in `AGENTS.md` (imported above).
The principles are in [.specify/memory/constitution.md](.specify/memory/constitution.md).

### Before non-trivial work

1. Read the feature spec (`specs/<NNN>/spec.md`, then `plan.md`). Then read the related `docs/`.
   They are the specification. They are not background.
2. Find a similar handler or agent and follow its pattern. Read `docs/adr/`.
3. Plan the smallest correct diff. TDD is the normal way to write behavior. It is not an exception.
4. If there are several reasonable options, or if a requirement is ambiguous, propose and ask.
   Do not guess.

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

- Do not commit or push unless the user asks you to.
- Do not read or print `.env`, keys or certificates.
- Customer source, logs and secrets stay in the execution plane. Only structured evidence can leave it.
- Documentation and identifiers are in English.
