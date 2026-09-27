# Boundary exceptions

012 FR-005: an exception to a boundary rule (`no-restricted-imports`, `no-restricted-syntax`, the
lint limits, `deps-check`'s dependency allowlist) exists only as a row in this table, referencing
an ADR and naming an owner. Inline suppression — `eslint-disable`, `eslint-disable-next-line` — is
not a form an exception can take: `eslint.config.mjs` sets `linterOptions.noInlineConfig: true`
repo-wide, so any such comment is a no-op and the rule it targeted still fires (012 T077).

The only way to actually except a path from a rule is an `ignores` entry in `eslint.config.mjs`
itself, or an entry in `deps-check`'s `ALLOWED_DEPENDENCIES` — both reviewed code, never a comment
slipped into an unrelated diff. Add the exception there, then record it below in the same change
set.

| Path / dependency | Rule | ADR | Owner | Why |
|--------------------|------|-----|-------|-----|
| _(none yet)_ | | | | |
