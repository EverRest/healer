#!/usr/bin/env node
// `deps-check` (012 T037, T078, FR-006): no unapproved dependency, permissive licences, lockfile
// in sync, the Postgres extension list from ADR 0004, and a new dependency carries an ADR in the
// same change set.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';
import { changedFilesSinceBase, resolveBaseRef } from '../lib/changed-files.mjs';

// Every field a dependency can be declared under — checking `dependencies` alone let a package
// added only under `devDependencies` (or the other two) skip the allowlist and ADR-diff checks
// entirely (FR-006).
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

export function allDependencyNames(pkg) {
  const names = new Set();
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(pkg[field] ?? {})) names.add(name);
  }
  return [...names];
}

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Every direct, non-`@healer/*` runtime dependency approved so far. Adding one here without
// also adding the ADR that approves it is exactly the gap FR-006 exists to close (see the
// module doc comment) — this list is reviewable, but is not yet itself gated on an ADR diff.
const ALLOWED_DEPENDENCIES = new Set([
  '@prisma/client',
  '@types/supertest',
  'supertest',
  '@opentelemetry/api',
  '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/resources',
  '@opentelemetry/sdk-node',
  '@opentelemetry/sdk-trace-node',
  '@opentelemetry/semantic-conventions',
  'pino',
  'zod',
  'bullmq',
  '@nestjs/common',
  '@nestjs/core',
  '@nestjs/platform-express',
  '@nestjs/swagger',
  'reflect-metadata',
  'rxjs',
]);

// ADR 0004: the only Postgres extensions this project may depend on.
const APPROVED_POSTGRES_EXTENSIONS = new Set(['vector', 'pg_trgm']);

const PERMISSIVE_LICENSES = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'BlueOak-1.0.0',
  'Python-2.0',
]);

/* v8 ignore start -- CLI wiring (real fs walk); logic below is unit tested */
function findPackageJsonFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...findPackageJsonFiles(full));
    } else if (entry === 'package.json' && !full.includes(`${join('prisma', 'generated')}`)) {
      results.push(full);
    }
  }
  return results;
}

/* v8 ignore stop */

/** @param {{ path: string, dependencies: string[] }[]} manifests */
export function findUnapprovedDependencies(manifests) {
  const issues = [];
  for (const { path, dependencies } of manifests) {
    for (const name of dependencies) {
      if (name.startsWith('@healer/')) continue;
      if (!ALLOWED_DEPENDENCIES.has(name))
        issues.push(`${path}: ${name} is not on the approved list (FR-006)`);
    }
  }
  return issues;
}

/**
 * T078, FR-006: a new dependency fails unless a changed ADR (in this same change set) mentions
 * it by name. `addedDependencyNames` is what's new in `package.json` versus the base revision;
 * `changedAdrContents` is the text of every `docs/adr/*.md` file this change set touched.
 * `@healer/*` is skipped, same as the allowlist check above: FR-006 governs external dependency
 * risk (licensing, supply chain, cost) — a new edge between our own workspace packages is an
 * architecture decision, not the kind of thing this gate exists to catch, and forcing an ADR on
 * every new internal import would just train people to pad an ADR with a name to get past a gate
 * that was never about that name.
 */
export function findUndocumentedNewDependencies(addedDependencyNames, changedAdrContents) {
  const externalNames = addedDependencyNames.filter((name) => !name.startsWith('@healer/'));
  if (externalNames.length === 0) return [];
  return externalNames
    .filter((name) => !changedAdrContents.some((content) => content.includes(name)))
    .map((name) => `${name}: new dependency with no ADR naming it in this change set (FR-006)`);
}

/** @param {Record<string, unknown>} licenseReport */
export function findImpermissiveLicenses(licenseReport) {
  return Object.keys(licenseReport).filter((license) => !PERMISSIVE_LICENSES.has(license));
}

/** @param {string} extensionsPreviewLine */
export function findUnapprovedExtensions(schemaSource) {
  const match = schemaSource.match(/extensions\s*=\s*\[([^\]]*)\]/);
  if (!match) return [];
  const declared = match[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return declared.filter((ext) => !APPROVED_POSTGRES_EXTENSIONS.has(ext));
}

/* v8 ignore start -- CLI wiring (real git calls); pure logic above and below is unit tested */
/**
 * Every dependency name approved anywhere in the monorepo at the base revision — not per file.
 * A dependency already vetted in one package.json needing a second ADR just because another
 * package.json also starts listing it would be noise FR-006 does not ask for; the real question
 * is whether this name is new to the repository at all. Checked across all four dependency
 * fields: FR-006 asks for an ADR on a new dependency, not only a new *runtime* one, so a package
 * added only under devDependencies must not skip this the way it correctly skips the runtime
 * allowlist above.
 */
function baseRevisionDependencyNames(packageJsonPaths, baseRef) {
  const names = new Set();
  for (const path of packageJsonPaths) {
    let content;
    try {
      content = execFileSync('git', ['show', `${baseRef}:${path}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
    } catch {
      continue; // did not exist at the base revision
    }
    for (const name of allDependencyNames(JSON.parse(content))) names.add(name);
  }
  return names;
}
/* v8 ignore stop */

/* v8 ignore start -- CLI wiring; logic above is unit tested */
if (isMainModule(import.meta.url)) {
  const result = await runGate('deps-check', () => {
    const changedFiles = changedFilesSinceBase();
    const manifests = findPackageJsonFiles(REPO_ROOT).map((path) => {
      const pkg = JSON.parse(readFileSync(path, 'utf8'));
      return { path, pkg, dependencies: Object.keys(pkg.dependencies ?? {}) };
    });
    const unapproved = findUnapprovedDependencies(manifests);
    if (unapproved.length > 0) throw new Error(unapproved.join('; '));

    const relativePaths = manifests.map(({ path }) => relative(REPO_ROOT, path));
    const before = baseRevisionDependencyNames(relativePaths, resolveBaseRef(REPO_ROOT));
    const afterNames = new Set(manifests.flatMap(({ pkg }) => allDependencyNames(pkg)));
    const added = [...afterNames].filter((name) => !before.has(name));
    const changedAdrContents = changedFiles
      .filter((f) => /^docs\/adr\/.*\.md$/.test(f))
      .map((f) => {
        try {
          return readFileSync(join(REPO_ROOT, f), 'utf8');
        } catch {
          return ''; // deleted in this change set — cannot document a dependency
        }
      });
    const undocumented = findUndocumentedNewDependencies(added, changedAdrContents);
    if (undocumented.length > 0) throw new Error(undocumented.join('; '));

    const schemaExtensionIssues = findUnapprovedExtensions(
      readFileSync(join(REPO_ROOT, 'prisma/schema.prisma'), 'utf8'),
    );
    if (schemaExtensionIssues.length > 0) {
      throw new Error(
        `unapproved Postgres extension (ADR 0004): ${schemaExtensionIssues.join(', ')}`,
      );
    }

    const licenseOutput = execFileSync('pnpm', ['licenses', 'list', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const impermissive = findImpermissiveLicenses(JSON.parse(licenseOutput));
    if (impermissive.length > 0)
      throw new Error(`non-permissive licence(s): ${impermissive.join(', ')}`);

    const lockfileCheck = spawnSync('pnpm', ['install', '--frozen-lockfile'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    if (lockfileCheck.status !== 0) {
      throw new Error(
        `lockfile out of sync with package.json: ${lockfileCheck.stdout}${lockfileCheck.stderr}`,
      );
    }
  });
  reportAndExit(result);
}
/* v8 ignore stop */
