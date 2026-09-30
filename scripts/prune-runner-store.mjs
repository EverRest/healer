#!/usr/bin/env node
// apps/runner/Dockerfile's prod-deps stage (012 T050 review finding): `pnpm install --prod
// --filter "@healer/runner..."` still populates the shared pnpm virtual store
// (node_modules/.pnpm) with the *entire* transitive closure of the workspace ROOT's own
// `dependencies` (@prisma/client, supertest — see root package.json), even though `pnpm why
// @prisma/client --filter "@healer/runner..."` correctly reports no path from the runner to it.
// Confirmed empirically: three different pnpm invocations (a plain scoped filter, an explicit
// `--filter '!{.}'`/`--filter '!.'` exclusion, and `pnpm deploy --legacy`) all still populated the
// store with @prisma/client, the prisma CLI, @prisma/engines, typescript, supertest, @types/*,
// fast-check and their own transitive dependencies (~150+ unrelated packages) — this appears to be
// inherent to installing against a single shared workspace lockfile, not something any `--filter`
// combination avoids.
//
// Rather than hand-maintain a denylist of package names to strip (a closed list with no single
// authority, guaranteed to drift the next time root gains a new dependency), this computes the
// real ALLOWED set directly from `pnpm list --json`'s own dependency tree for exactly the projects
// apps/runner actually needs (itself, @healer/boundary-contract, @healer/shared) and deletes every
// other *versioned* store entry. `pnpm list`'s own tree is authoritative — `pnpm why` returning
// empty for @prisma/client already proves it agrees the runner's real graph never reaches it.
import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isMainModule } from './lib/harness.mjs';

const RUNNER_FILTER = '@healer/runner...';

// Every dependency node `pnpm list --json` reports carries a real filesystem `path`; for anything
// resolved through the shared store that path always contains a `node_modules/.pnpm/<STORE_KEY>/
// node_modules/<pkg>` segment — capturing STORE_KEY directly is exact (scoped-name `/` -> `+`
// encoding and peer-dependency suffixes included) and needs no separate reconstruction from name
// and version. A workspace-linked dependency's `path` never matches (it points straight at
// `packages/<name>`), which is correct: nothing to allow-list there, it is not a store entry.
const STORE_PATH_RE = /node_modules[/\\]\.pnpm[/\\]([^/\\]+)[/\\]node_modules[/\\]/;

/** @param {Record<string, unknown> | undefined} dependencies one `pnpm list --json` node's own
 *  `dependencies` map (recursive: each value may carry its own nested `dependencies`) */
function collectStoreKeys(dependencies, keys) {
  if (!dependencies || typeof dependencies !== 'object') return;
  for (const info of Object.values(dependencies)) {
    const path = /** @type {{ path?: unknown, dependencies?: unknown }} */ (info)?.path;
    if (typeof path === 'string') {
      const match = path.match(STORE_PATH_RE);
      if (match) keys.add(match[1]);
    }
    collectStoreKeys(/** @type {any} */ (info)?.dependencies, keys);
  }
}

/**
 * @param {ReadonlyArray<{ dependencies?: Record<string, unknown> }>} pnpmListJson parsed
 *   `pnpm list --json --depth Infinity` output — one entry per matched project.
 * @returns {Set<string>} every store key (e.g. `zod@3.25.76`,
 *   `@opentelemetry+sdk-node@0.222.0_@opentelemetry+api@1.9.1`) genuinely reachable from them.
 */
export function computeAllowedStoreKeys(pnpmListJson) {
  const keys = new Set();
  for (const project of pnpmListJson) collectStoreKeys(project.dependencies, keys);
  return keys;
}

// A pnpm virtual store's top level also holds its own bookkeeping (`lock.yaml`, a `node_modules`
// directory of hoisted `.bin` shims) alongside one directory per resolved package version — only
// the latter looks like `<name>@<digit...>` (a scoped name's `/` is already `+`-encoded by pnpm
// itself, so `@scope+name@1.2.3` still matches `@\d` at its *own* version, not the scope).
const VERSIONED_ENTRY_RE = /@\d/;

/** @param {string} entryName one entry from `node_modules/.pnpm`'s own directory listing */
export function isPackageStoreEntry(entryName) {
  return VERSIONED_ENTRY_RE.test(entryName);
}

/**
 * Never true for `lock.yaml`/`node_modules` or anything else that is not a versioned package
 * directory — pruning is scoped strictly to entries this module can actually reason about.
 * @param {string} entryName
 * @param {ReadonlySet<string>} allowedKeys
 */
export function shouldPruneStoreEntry(entryName, allowedKeys) {
  return isPackageStoreEntry(entryName) && !allowedKeys.has(entryName);
}

/* v8 ignore start -- real pnpm/fs calls; decision logic above is unit tested directly */
if (isMainModule(import.meta.url)) {
  const repoRoot = process.cwd();
  const storeDir = join(repoRoot, 'node_modules', '.pnpm');
  const listingJson = execFileSync(
    'pnpm',
    ['list', '--json', '--filter', RUNNER_FILTER, '--prod', '--depth', 'Infinity'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const allowed = computeAllowedStoreKeys(JSON.parse(listingJson));

  let removed = 0;
  for (const entry of readdirSync(storeDir)) {
    if (shouldPruneStoreEntry(entry, allowed)) {
      rmSync(join(storeDir, entry), { recursive: true, force: true });
      removed += 1;
    }
  }
  process.stdout.write(
    `prune-runner-store: kept ${allowed.size} package(s), removed ${removed} unreachable one(s) from ${storeDir}\n`,
  );
}
/* v8 ignore stop */
