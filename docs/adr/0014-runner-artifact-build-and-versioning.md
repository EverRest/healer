# ADR 0014: runner artifact build, versioning and packaging

## Status

Accepted — 2026-09-29

## Context

012 phase 6 (T049, T050) ships the runner as a container image for the first time — no
Dockerfile exists anywhere in the repo today; `docker/docker-compose.yml` is explicitly
local-dev-only (constitution VIII: no Terraform, no Kubernetes for v1; C-39 already closes the
deployment-wrapper choice to Docker Compose, exactly one wrapper). FR-017 requires the runner be
"released as an independently versioned artifact, immutable version id, published checksum,
changelog; a published version MUST NOT be rebuilt in place." `apps/runner/package.json` already
carries its own `version` field (0.5.0), separate from the repo-wide `VERSION` file that
`docs/changelog.md` tracks — the runner's release cadence is its own, not tied to the monorepo's.

No registry or hosting exists for this repo (Docker Hub, ECR, a self-hosted registry) — inventing
one is out of scope; per `AGENTS.md`, that stays an open question in `QUESTIONS.md` rather than
guessed infrastructure.

## Decision

- `apps/runner/Dockerfile`: a plain multi-stage Node image (matches the toolchain already used
  everywhere else — pnpm, TypeScript build to `dist/`), no new base-image or runtime dependency.
- `make runner-build`:
  1. reads the version id from `apps/runner/package.json`'s `version` field (the artifact's own
     version, not `VERSION`);
  2. builds `apps/runner/Dockerfile` and tags the image `healer-runner:<version>`;
  3. computes a checksum over the built image (`docker inspect --format='{{.Id}}'`, the image's
     content-addressed digest — no extra tool, Docker already computes this);
  4. **refuses to proceed** if a local image already exists at that tag with a *different*
     digest — the mechanism that makes "MUST NOT be rebuilt in place" a checked fact rather than a
     convention. A rebuild that reproduces the same digest is a no-op, not a violation.
  5. writes `<version>` and the digest to a stamp file (`apps/runner/dist/runner-release.json`)
     that `make runner-diagnostics` and the compose wrapper both read — one authority for "what
     version is this," not three copies.
- Publishing (pushing to a registry, writing a changelog entry customers see) is **not** part of
  `runner-build` — it stays a manual step until a registry exists. Tracked as an open item in
  `QUESTIONS.md` rather than invented here.
- `docker-compose.runner.yml` (a new file, distinct from the dev-only `docker/docker-compose.yml`)
  is the single v1 deployment wrapper (C-39): one service, image tag taken from an environment
  variable (`RUNNER_IMAGE_TAG`, default the stamp file's version) so upgrade/rollback is "change
  the tag, `docker compose up`" — no orchestrator, no second wrapper format.

## Consequences

- \+ FR-017's "must not be rebuilt in place" has a reader: `runner-build` itself refuses a
  content-changing rebuild at the same tag, rather than relying on a human not to `docker build`
  twice.
- \+ No new dependency: Docker's own digest, already computed on every build, is the checksum —
  no `sha256sum`/manifest-signing tool introduced for a v1 with no registry to publish to anyway.
- \+ One stamp file is the sole source `runner-diagnostics` and the compose wrapper read for
  "what version is running" — a second copy of that fact was the exact failure this ADR's
  process (`00-core.md`: "a closed list has exactly one authority") warns against.
- − Rollback ("restore the previous version," FR-019) is only as good as whatever local images
  are still on disk — there is no registry to pull an older tag back from once it is gone. Adequate
  for a design-partner v1 with no registry; revisited when one exists.
- Rejected: pushing to a registry as part of `runner-build`. No registry is provisioned; guessing
  one (Docker Hub org, ECR repo, self-hosted) is exactly the "don't invent infrastructure that
  doesn't exist" the task explicitly calls out. Left in `QUESTIONS.md`.
- Rejected: a Helm chart alongside Compose. C-01/C-39 already close this — one wrapper, matching
  what the design partner runs, until a second customer's requirements justify a second one.
