#!/usr/bin/env node
// `gate-architecture-agnostic` (012 T032, constitution VII, 004 SC-008, FR-016a).
//
// The domain models Component, not Service — monolith, microservices and serverless are
// different graphs, not different products (constitution VII). A domain or agent package that
// names a customer's concrete deployment style is the architecture-conditional branch 004
// SC-008 forbids outside adapter code.
//
// Also checks our *own* stack vocabulary (Postgres/Prisma/BullMQ/Redis) leaking into the same
// packages — a second independent check, deliberately redundant with the T035 import-boundary
// lint (`@prisma/client` outside infrastructure, etc.): that one is structural (module
// resolution), this one is textual and catches vocabulary even where no import is involved.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';
import { stripComments } from '../lib/strip-comments.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCAN_ROOTS = ['packages/domain', 'packages/agents'];
// A customer's style is named nowhere in first-party code except the adapters: all of it is scanned.
const TERM_SCAN_ROOTS = ['packages', 'apps'];
// Own-stack vocabulary is exempt in these (the module is the stack's seam).
const EXEMPT_DIR_PATTERN = /(^|\/)(adapters|discovery|infrastructure)(\/|$)/;
// Style vocabulary is exempt only in adapters/discovery directories — `infrastructure/` is exempt
// for our own stack, not for the customer's style. (FR-020 allows "adapters and discovery"; T050
// names only packages/integrations/** — see QUESTIONS.md "T049-T050".)
const STYLE_EXEMPT_DIR_PATTERN = /(^|\/)(adapters|discovery)(\/|$)/;
// The one place architecture-specific logic may live (FR-020, 004 T050): a path pattern, so a new
// adapter package needs no edit here (012 FR-002). Repo-relative, so anchored at the start.
const INTEGRATIONS_PATTERN = /^packages\/integrations\//;
// `isMonolith` -> `is Monolith`, `ECSCluster` -> `ECS Cluster`, `isAWSLambda` -> `is AWS Lambda`,
// `k8s_cluster` -> `k8s cluster`, `micro-service` -> `micro service`: the word-bounded term list
// below then catches a style named in an identifier or a string, whatever its spelling.
const splitIdentifiers = (line) =>
  line
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]/g, ' ');

// Customer deployment/architecture vocabulary (004 SC-008) — not our own stack, which the
// import-boundary lint (T035) already governs.
const BANNED_TERMS = [
  'monolith',
  'monolithic',
  'microservice',
  'microservices',
  'micro service',
  'serverless',
  'kubernetes',
  'k8s',
  'lambda',
  'fargate',
  'ecs',
  'openshift',
  'nomad',
  'heroku',
  'vercel',
  'netlify',
  'docker swarm',
  'azure functions',
  'cloud run',
];
const BANNED_PATTERN = new RegExp(
  `\\b(${BANNED_TERMS.map((t) => t.replace(/\s+/g, '\\s*')).join('|')})s?\\b`,
  'gi',
);

// Our own stack (AGENTS.md), second independent check — see file header.
const OWN_STACK_TERMS = ['postgres', 'postgresql', 'prisma', 'pgvector', 'bullmq', 'redis'];
const OWN_STACK_PATTERN = new RegExp(`\\b(${OWN_STACK_TERMS.join('|')})\\b`, 'gi');

// A barrel file's own import/export path legitimately names an infrastructure module by filename
// (`export * from './infrastructure/prisma-evidence-repository.js'`) — the module it points at is
// exempt, not the barrel itself. Skip a line's own-stack check when its import/export specifier
// resolves into an exempt directory.
const IMPORT_SPECIFIER_PATTERN = /(?:from|require\()\s*['"]([^'"]+)['"]/;
function importsFromExemptDir(line) {
  const match = IMPORT_SPECIFIER_PATTERN.exec(line);
  return match != null && EXEMPT_DIR_PATTERN.test(match[1]);
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx']);
/** Source we scan: every JS/TS flavour, never declarations or tests (the existing convention). */
export function isScannedFile(name) {
  return (
    SOURCE_EXTENSIONS.has(extname(name)) && !name.endsWith('.d.ts') && !/\.(test|spec)\./.test(name)
  );
}

/** A root that yields nothing is a gate scanning nothing — fail closed, never pass vacuously. */
export function assertEveryRootScanned(files, roots) {
  for (const root of roots)
    if (!files.some((f) => f.path.replace(/\\/g, '/').startsWith(`${root}/`)))
      throw new Error(`scan root ${root} yielded no files`);
}

/* v8 ignore start -- CLI wiring (real fs walk); findArchitectureLeaks above is unit tested */
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      yield* walk(full);
    } else if (isScannedFile(entry)) {
      yield full;
    }
  }
}

/* v8 ignore stop */

/** @param {{ path: string, content: string }[]} files */
export function findArchitectureLeaks(files) {
  const issues = [];
  for (const { path: rawPath, content } of files) {
    const path = rawPath.replace(/\\/g, '/');
    if (INTEGRATIONS_PATTERN.test(path)) continue;
    const stripped = stripComments(content);
    const lines = stripped.split('\n');
    const mayNameStyle = STYLE_EXEMPT_DIR_PATTERN.test(path);
    const ownStackScope =
      !EXEMPT_DIR_PATTERN.test(path) && SCAN_ROOTS.some((root) => path.startsWith(`${root}/`));
    lines.forEach((line, index) => {
      // The rule is the term, not the shape of the statement around it: a style named in a
      // comparison, a switch, an object key, an `.includes()`, an alias or a regex is all the same
      // dependency on the customer's architecture.
      if (!mayNameStyle) {
        for (const match of splitIdentifiers(line).matchAll(BANNED_PATTERN)) {
          issues.push(
            `${path}:${index + 1}: names "${match[1]}" — customer architecture style (only packages/integrations/** may)`,
          );
        }
      }
      if (ownStackScope && !importsFromExemptDir(line)) {
        for (const match of line.matchAll(OWN_STACK_PATTERN)) {
          issues.push(`${path}:${index + 1}: names "${match[1]}" — own stack vocabulary`);
        }
      }
    });
  }
  return issues;
}

/* v8 ignore start -- CLI wiring; findArchitectureLeaks above is unit tested */
if (isMainModule(import.meta.url)) {
  let scanned = 0;
  const result = await runGate('gate-architecture-agnostic', () => {
    const files = TERM_SCAN_ROOTS.flatMap((root) =>
      [...walk(join(REPO_ROOT, root))].map((path) => ({
        path: relative(REPO_ROOT, path).split(sep).join('/'),
        content: readFileSync(path, 'utf8'),
      })),
    );
    assertEveryRootScanned(files, [...TERM_SCAN_ROOTS, ...SCAN_ROOTS]);
    const issues = findArchitectureLeaks(files);
    if (issues.length > 0) throw new Error(issues.join('; '));
    scanned = files.length;
  });
  reportAndExit({ ...result, scanned });
}
/* v8 ignore stop */
