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
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';
import { stripComments } from '../lib/strip-comments.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCAN_ROOTS = ['packages/domain', 'packages/agents'];
// Branches are searched across all first-party code, not only the domain/agent packages.
const BRANCH_SCAN_ROOTS = ['packages', 'apps'];
const EXEMPT_DIR_PATTERN = /(^|\/)(adapters|discovery|infrastructure)(\/|$)/;
// The one place architecture-specific logic may live (FR-020, 004 T050): a path pattern, so a new
// adapter package needs no edit here (012 FR-002). Repo-relative, so anchored at the start.
const INTEGRATIONS_PATTERN = /^packages\/integrations\//;
// A line that decides something: a branch keyword, a (in)equality or a ternary.
const BRANCH_CONSTRUCT = /\b(?:if|while|switch|case)\b|[!=]==?|\s\?\s/;
// `isMonolith` -> `is Monolith`, `k8s_cluster` -> `k8s cluster`: the word-bounded term list below
// then catches a style named in an identifier as well as in a string.
const splitIdentifiers = (line) => line.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/_/g, ' ');

// Customer deployment/architecture vocabulary (004 SC-008) — not our own stack, which the
// import-boundary lint (T035) already governs.
const BANNED_TERMS = [
  'monolith',
  'monolithic',
  'microservice',
  'microservices',
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
  `\\b(${BANNED_TERMS.map((t) => t.replace(/\s+/g, '\\s+')).join('|')})\\b`,
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

/* v8 ignore start -- CLI wiring (real fs walk); findArchitectureLeaks below is unit tested */
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      yield* walk(full);
    } else if (extname(entry) === '.ts' && !entry.endsWith('.test.ts')) {
      yield full;
    }
  }
}

/* v8 ignore stop */

/** @param {{ path: string, content: string }[]} files */
export function findArchitectureLeaks(files) {
  const issues = [];
  for (const { path, content } of files) {
    if (INTEGRATIONS_PATTERN.test(path)) continue;
    const stripped = stripComments(content);
    const lines = stripped.split('\n');
    lines.forEach((line, index) => {
      // Not subject to the adapters/discovery/infrastructure exemption: infrastructure/ is exempt
      // for our own stack, not for branching on the customer's style.
      if (BRANCH_CONSTRUCT.test(line)) {
        for (const match of splitIdentifiers(line).matchAll(BANNED_PATTERN)) {
          issues.push(
            `${path}:${index + 1}: architecture-conditional branch on "${match[1]}" — only packages/integrations/** may branch on style`,
          );
        }
      }
      if (EXEMPT_DIR_PATTERN.test(path) || !SCAN_ROOTS.some((root) => path.startsWith(`${root}/`)))
        return;
      for (const match of line.matchAll(BANNED_PATTERN)) {
        issues.push(`${path}:${index + 1}: names "${match[1]}" — customer architecture style`);
      }
      if (!importsFromExemptDir(line)) {
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
  const result = await runGate('gate-architecture-agnostic', () => {
    const files = BRANCH_SCAN_ROOTS.flatMap((root) => {
      const abs = join(REPO_ROOT, root);
      return [...walk(abs)].map((path) => ({
        path: relative(REPO_ROOT, path),
        content: readFileSync(path, 'utf8'),
      }));
    });
    const issues = findArchitectureLeaks(files);
    if (issues.length > 0) throw new Error(issues.join('; '));
  });
  reportAndExit(result);
}
/* v8 ignore stop */
