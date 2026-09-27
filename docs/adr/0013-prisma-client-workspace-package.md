# ADR 0013: a dedicated `@healer/prisma-client` workspace package

## Status

Accepted — 2026-09-27

## Context

001 T006 is the first `infrastructure/` code anywhere in the repo that needs to construct real
queries against the generated Prisma client (every prior use was raw SQL through `psql`, in
`test/containers.ts`-based e2e tests, or `prisma migrate`/`prisma generate` as a subprocess —
never the client's query builder from TypeScript). `prisma/schema.prisma`'s `generator client`
block sets a custom `output = "../prisma/generated/client"` (needed for the multi-schema,
project-references monorepo layout), which means the generated client is **not** the
`node_modules/@prisma/client` package — it is its own self-contained package, complete with its
own `package.json`, at `prisma/generated/client/`.

That directory is not a pnpm workspace member (`pnpm-workspace.yaml` lists `apps/*`,
`packages/*`, `packages/domain/*` — not `prisma/*`), and cannot become a plain relative import
target either: every package's `tsconfig.json` sets `rootDir: "src"`, and TypeScript's project
references refuse a relative import that reaches outside a package's own `rootDir` (the same
enclosure check that made T035's now-removed depth-based import lint redundant — see
`QUESTIONS.md`). Twelve `packages/domain/*` packages will each eventually need an
`infrastructure/` folder with exactly this same dependency, so however T006 solves it becomes the
pattern all of them inherit.

## Decision

A small dedicated workspace package, `packages/prisma-client`, whose only job is to re-export the
generated client:

```ts
// packages/prisma-client/src/index.ts
export * from '@healer/prisma-generated';
```

`packages/prisma-client/package.json` depends on the generated output via pnpm's `link:` protocol
(`"@healer/prisma-generated": "link:../../prisma/generated/client"`) — the one place in the repo that
names that path. Every `infrastructure/` folder that needs the client depends on
`@healer/prisma-client: workspace:*`, the same `workspace:*` convention already used for
`@healer/shared`/`@healer/events` — never on the generated output's path or its own
(content-hashed, unstable) package name directly.

## Consequences

- \+ One place names `prisma/generated/client`'s path; twelve future repositories depend on a
  normal, stably-named workspace package instead of twelve copies of a `link:` entry pointing at a
  build artifact three directories up.
- \+ `@prisma/client` stays confined to `**/infrastructure/**` and `prisma/**`
  (`backend-nestjs.md`) exactly as before: `packages/prisma-client` itself is not infrastructure
  code and does not import `@prisma/client` — it re-exports the *custom-output* generated client,
  a different package, so the existing eslint rule's glob is untouched and still governs the real
  restriction (no domain/application code reaching the client directly).
- \+ Regenerating the client (`prisma generate`, already the first step of `db-check` and
  `make bootstrap`) needs no change anywhere else — the `link:` symlink resolves to whatever is
  currently on disk.
- − An extra package to route through, and its dependency on a build artifact (not a checked-in
  Prisma client) means a clean checkout must run `prisma generate` before `typecheck`/`build` can
  resolve it — already true today (nothing in the repo currently ships a committed client), and
  already the order `make ci` enforces (`db-check` before `typecheck`/`build`).
- Rejected: each `infrastructure/` folder taking its own `link:` dependency directly on
  `prisma/generated/client`. Works, but scatters the same magic relative path across every future
  repository's `package.json` and makes a later change to the generator's `output` path (or a move
  to a checked-in client) a twelve-file change instead of a one-file change.
- Rejected: moving the generator's `output` into `packages/` so it becomes a workspace member on
  its own. Rejected because Prisma names the generated package after a content hash, not a stable
  name pnpm can key a `workspace:*` dependency on, and because it would touch every script that
  currently assumes `prisma/generated/client` (`db-check.mjs`, `migration.e2e.test.ts`,
  `bootstrap`) for a problem this package already solves without moving anything.
