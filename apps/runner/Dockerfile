# apps/runner/Dockerfile (012 T050, ADR 0014: runner artifact build and versioning).
#
# Plain multi-stage Node/pnpm image — no new base image or runtime dependency beyond what the
# repo already uses everywhere (pnpm workspaces, `tsc --build` project references).
#
# Build strategy: SCOPED, not whole-monorepo. `apps/runner` depends on exactly two workspace
# packages (@healer/boundary-contract, @healer/shared — see apps/runner/package.json and
# tsconfig.json's own `references`), neither of which touches Prisma. The root `pnpm run build`
# script (`tsc --build tsconfig.json`) builds *every* package in the workspace, including
# `packages/prisma-client`, which requires a generated Prisma client
# (`link:../../prisma/generated/client`, from `pnpm run db-generate`) before it will typecheck —
# a network-dependent step with nothing to do with the runner. Scoping the pnpm install to
# `@healer/runner...` (the package and its workspace dependencies) and the build to
# `tsc --build apps/runner/tsconfig.json` (the exact project-reference subgraph TypeScript's own
# build system already knows about) avoids pulling that in, without hand-rolling a second build
# mechanism — it is the same `tsc --build` the root script uses, just given the narrower project
# root that already exists for this purpose. Recorded in QUESTIONS.md.
#
# Runtime layout mirrors the repo's own directory nesting exactly (apps/runner, packages/*, root
# node_modules) because pnpm's workspace node_modules are relative symlinks — preserving the same
# relative depth is what makes a copied `node_modules` tree still resolve after the copy.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.6.2 --activate
WORKDIR /repo

# ---- build: compile apps/runner + its two workspace deps, nothing else ----
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile --filter "@healer/runner..." --filter "{.}"
RUN pnpm exec tsc --build apps/runner/tsconfig.json
# `tsconfig.json`'s own `include: ["src/**/*"]` compiles test files too (needed so `pnpm run
# typecheck` actually checks them) — strip their compiled output before it ships in an image
# nothing runs tests from (012 T050 review).
RUN find apps/runner/dist packages/boundary-contract/dist packages/shared/dist -name '*.test.*' -delete

# ---- prod-deps: same scoped filter, production dependencies only ----
FROM base AS prod-deps
COPY . .
RUN pnpm install --frozen-lockfile --prod --filter "@healer/runner..."
# `pnpm install --filter "@healer/runner..."` still populates the shared pnpm store with the
# *entire* transitive closure of the workspace root's own `dependencies` (@prisma/client,
# supertest — confirmed empirically across three different pnpm invocations; see
# scripts/prune-runner-store.mjs's own doc comment for the full account). Delete everything from
# the store that apps/runner's real dependency graph does not actually reach (012 T050 review).
RUN node scripts/prune-runner-store.mjs

# ---- runtime: only what `node dist/main.js` needs — no devDependencies, no other apps' source ----
# Two layers against the root-dependency leak explained above `prune-runner-store.mjs`'s call:
# (1) that script has already deleted everything unreachable from the store by this point, and
# (2) only `node_modules/.pnpm` itself is copied here, never the top-level `/repo/node_modules`
# (which also carries the workspace root's own hoisted symlinks — irrelevant to apps/runner either
# way, and simply never copied). Verified by `runner-image.e2e.test.ts`: the built image's
# `node_modules/.pnpm` contains nothing under `@prisma/` or `prisma@`.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /repo/node_modules/.pnpm ./node_modules/.pnpm
COPY --from=prod-deps /repo/apps/runner/package.json ./apps/runner/package.json
COPY --from=prod-deps /repo/apps/runner/node_modules ./apps/runner/node_modules
COPY --from=prod-deps /repo/packages/boundary-contract/package.json ./packages/boundary-contract/package.json
COPY --from=prod-deps /repo/packages/boundary-contract/node_modules ./packages/boundary-contract/node_modules
COPY --from=prod-deps /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=prod-deps /repo/packages/shared/node_modules ./packages/shared/node_modules

COPY --from=build /repo/apps/runner/dist ./apps/runner/dist
COPY --from=build /repo/packages/boundary-contract/dist ./packages/boundary-contract/dist
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist

# Outbound-only by construction (apps/runner/src/main.ts's own doc comment): no `EXPOSE`, nothing
# here binds a port. `node dist/main.js` — the same CLI-entrypoint-guard pattern apps/api and
# apps/worker use (`if (process.argv[1]?.endsWith('main.js'))`).
USER node
CMD ["node", "apps/runner/dist/main.js"]
