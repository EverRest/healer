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

# ---- prod-deps: same scoped filter, production dependencies only ----
FROM base AS prod-deps
COPY . .
RUN pnpm install --frozen-lockfile --prod --filter "@healer/runner..."

# ---- runtime: only what `node dist/main.js` needs — no devDependencies, no other apps' source ----
# Only `node_modules/.pnpm` (pnpm's content-addressed virtual store) is copied from the root, not
# the whole `/repo/node_modules` — that top level also carries symlinks for the *workspace root's
# own* `dependencies` (this repo's root package.json lists @prisma/client, supertest; confirmed
# empirically that `pnpm install --filter "@healer/runner..."` still installs those, even though
# `pnpm list` with the same filter excludes root — a pnpm quirk, not something this image needs).
# Nothing apps/runner imports is a direct root dependency, and each package below already has its
# own local `node_modules` of real symlinks into the store, so the unwanted top-level ones are
# simply never copied rather than fought with a pnpm flag.
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
