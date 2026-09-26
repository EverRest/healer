# Research

Knowledge that specs depend on but that does not belong in `docs/`. `docs/` describes what we
are building; `research/` describes what we learned about the world we are building it in.

```text
research/
├── raw/        verbatim source material — never edited, only added
└── wiki/       consolidated understanding — edited in place, one page per topic
    ├── index.md   every page has a row here, or it does not exist
    └── log.md     dated entries: decisions, reviews, what changed and why
```

## ingest

New material (a conversation, an article, a postmortem, benchmark output) goes to `raw/` verbatim
with a dated filename and a one-line provenance header. Then the relevant `wiki/` page is
**updated in place** — not appended to, not duplicated with a new date.

If the new material contradicts a wiki page, that is the interesting case: record both, mark which
one is now believed, and say why in `log.md`. Silent overwrite loses the reason.

## query

Read `wiki/index.md` first. Pages are written to be read by an agent picking up cold context — no
pronouns without antecedents, no "as discussed above" across files, every claim either sourced or
marked `(unverified)`.

## lint

Before every `/speckit-plan`, check:

- contradictions between `constitution.md`, `specs/`, `docs/` and `wiki/`
- claims that were true when written and are not now
- pages with no inbound links from `index.md` or from a spec
- market and pricing figures still marked `(unverified)` but being used as if verified

Findings go in `log.md`, not into the pages being linted.
