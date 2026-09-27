# ADR 0012: OpenAPI generated via @nestjs/swagger

## Status

Accepted — 2026-09-27

## Context

`contracts-check` (012 T033, FR-009, FR-012) needs the OpenAPI document generated from code and
committed, with drift detected on every `make ci`. `@nestjs/swagger` was already named in 012's
plan (Technical Context, Primary Dependencies) before any code existed, but a plan.md mention is
not an ADR, and adding the dependency itself still needs one — `deps-check`'s own ADR-diff check
(T078) correctly refused to pass without this document.

## Decision

Generate the committed OpenAPI document (`apps/api/openapi.json`) via `@nestjs/swagger`'s
`SwaggerModule.createDocument`, from a dedicated module (`apps/api/src/openapi.ts`) that builds
the same `ApiModule` shape `main.ts` uses, so the two can never describe different routes.
Generation needs no environment variable and no database connection: it only reads route
metadata, never `loadConfig()`.

## Consequences

- \+ One committed artifact, one drift check, in the same mechanism every other generated artifact
  (the Prisma client, the migration set) already uses.
- \+ No hand-written OpenAPI to fall out of sync with the routes.
- − A second NestJS dependency (`@nestjs/swagger`) alongside `@nestjs/core`/`common`/
  `platform-express`, tied to their major version.
- Rejected: hand-writing the OpenAPI document. It would drift from the routes the first time a
  controller changed and nobody remembered to update it — exactly the class of gap FR-009 exists
  to close mechanically rather than by discipline.
