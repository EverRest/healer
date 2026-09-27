#!/usr/bin/env node
// `gate-isolation` (012 T029, FR-013, 001 FR-015, 001 SC-004): every HTTP endpoint from the
// generated contract must have a test asserting another tenant receives not-found.
//
// Detection is a real function call, not prose-matching: an isolation test calls
// `assertTenantIsolated(app, method, path)` (test/tenant-isolation.ts), naming the exact route.
// A route with no such call anywhere in an e2e test file is reported.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';
import { stripComments } from '../lib/strip-comments.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OPENAPI_PATH = fileURLToPath(new URL('../../apps/api/openapi.json', import.meta.url));

// Paths that are not tenant-scoped by nature — the single authority for this exemption; a
// route added here without also being genuinely tenant-free is a reviewable, visible line,
// not a silent gap.
const EXEMPT_PATHS = new Set(['/health', '/ready']);

const CALL_PATTERN =
  /assertTenantIsolated\s*\(\s*[^,]+,\s*['"]([A-Z]+)['"]\s*,\s*['"]([^'"]+)['"]/g;

function normalizePath(path) {
  return path.replace(/\{([^}]+)\}/g, ':$1');
}

// A commented-out call, or one inside `it.skip(...)`/`describe.skip(...)`, never actually runs —
// counting it as coverage would let a test that was disabled (or never finished) silently satisfy
// the gate. `stripComments` removes the first; this removes the second by deleting each `.skip(`
// call's entire balanced-paren body (a regex can match the call's start but not its matching
// close, since nesting depth isn't fixed).
const SKIP_CALL_START = /\b(?:it|test|describe)\.skip\s*\(/g;

function stripSkippedBlocks(source) {
  let result = '';
  let cursor = 0;
  SKIP_CALL_START.lastIndex = 0;
  let match;
  while ((match = SKIP_CALL_START.exec(source))) {
    const openParenIndex = match.index + match[0].length - 1;
    let depth = 1;
    let i = openParenIndex + 1;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
      i++;
    }
    result += source.slice(cursor, match.index);
    cursor = i;
    SKIP_CALL_START.lastIndex = i;
  }
  result += source.slice(cursor);
  return result;
}

/** @param {{ paths: Record<string, Record<string, unknown>> }} openapi */
export function endpointsRequiringIsolation(openapi) {
  const endpoints = [];
  for (const [path, methods] of Object.entries(openapi.paths ?? {})) {
    if (EXEMPT_PATHS.has(path)) continue;
    for (const method of Object.keys(methods)) {
      endpoints.push(`${method.toUpperCase()} ${normalizePath(path)}`);
    }
  }
  return endpoints;
}

/** @param {string[]} testSources */
export function coveredEndpoints(testSources) {
  const covered = new Set();
  for (const source of testSources) {
    const scannable = stripSkippedBlocks(stripComments(source));
    for (const match of scannable.matchAll(CALL_PATTERN)) {
      covered.add(`${match[1].toUpperCase()} ${normalizePath(match[2])}`);
    }
  }
  return covered;
}

export function findUncoveredEndpoints(openapi, testSources) {
  const covered = coveredEndpoints(testSources);
  return endpointsRequiringIsolation(openapi).filter((endpoint) => !covered.has(endpoint));
}

/* v8 ignore start -- CLI wiring (real fs walk); logic above is unit tested */
function* walkTestFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) yield* walkTestFiles(full);
    else if (entry.name.endsWith('.e2e.test.ts')) yield full;
  }
}

if (isMainModule(import.meta.url)) {
  const result = await runGate('gate-isolation', () => {
    const openapi = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8'));
    const testSources = [...walkTestFiles(REPO_ROOT)].map((path) => readFileSync(path, 'utf8'));
    const uncovered = findUncoveredEndpoints(openapi, testSources);
    if (uncovered.length > 0) {
      throw new Error(`no tenant-isolation test for: ${uncovered.join(', ')}`);
    }
  });
  reportAndExit(result);
}
/* v8 ignore stop */
