#!/usr/bin/env node
// `gate-graph-confirm-capability` (004 T015, FR-010, R-09).
//
// "No agent credential carries `graph:confirm`; no MCP tool exposes confirmation"
// (graph-contract.md §5) is a fact about today's repository, not an enforcement mechanism — no
// capability or credential registry exists anywhere in this codebase yet (002-policy's to build,
// out of this feature's scope). Until one does, the only guard available is structural: scan every
// place a confirm path for the graph could be exposed — MCP tool registrations, application
// commands, job handlers — and fail if one appears without referencing
// `GRAPH_CONFIRM_CAPABILITY` (`packages/domain/architecture/src/domain/capabilities.ts`).
//
// Necessarily a mostly-vacuous check today: `ConfirmDraftItems` is Phase 3 work (004 T026) and
// nothing in this scan set currently mentions graph confirmation at all. The value is what it
// catches the day Phase 3 adds one — this is the regression guard, not a compliance report.
//
// Textual, like `gate-architecture-agnostic`: it cannot see whether a referenced capability is
// actually *checked* before the handler runs, only whether the constant is mentioned in the same
// file. A stronger (AST/call-graph) version is future work if this proves too weak in practice.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';
import { stripComments } from '../lib/strip-comments.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Every place a confirm path could be wired up today (FR-010's own words: "no MCP tool, in-process
// command interface or job handler"). `apps/api/src` is included too: a controller dispatching a
// command is as much an exposure as the command itself.
const APP_SCAN_ROOTS = ['apps/mcp-server/src', 'apps/worker/src', 'apps/api/src'];

// Application commands live inside each domain package at `application/commands/`; scanning all of
// `packages` and filtering to this path segment (rather than listing every package by name) is what
// keeps this check honest as new domain packages are added.
const COMMANDS_DIR_PATTERN = /(^|\/)application\/commands\//;

// Catches `ConfirmDraftItems`, `confirmDraftItem`, `confirm-draft`, an MCP tool id like
// `graph_confirm` or `graph.confirm`, and the capability string `graph:confirm` used as something
// granted rather than required — any shape of "confirm" paired with "graph" or "draft".
const CONFIRM_PATTERN =
  /confirm[a-z_-]*draft|draft[a-z_-]*confirm|graph[a-z_.:-]*confirm|confirm[a-z_.:-]*graph/i;

const CAPABILITY_REFERENCE = 'GRAPH_CONFIRM_CAPABILITY';

/* v8 ignore start -- CLI wiring (real fs walk); findUncappedConfirmExposures below is unit tested */
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

export function collectConfirmSurfaceFiles() {
  const files = [];
  for (const root of APP_SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    files.push(...walk(abs));
  }
  const packagesAbs = join(REPO_ROOT, 'packages');
  for (const path of walk(packagesAbs)) {
    if (COMMANDS_DIR_PATTERN.test(relative(REPO_ROOT, path))) files.push(path);
  }
  return files.map((path) => ({
    path: relative(REPO_ROOT, path),
    content: readFileSync(path, 'utf8'),
  }));
}
/* v8 ignore stop */

/** @param {{ path: string, content: string }[]} files */
export function findUncappedConfirmExposures(files) {
  const issues = [];
  for (const { path, content } of files) {
    const stripped = stripComments(content);
    if (!CONFIRM_PATTERN.test(stripped)) continue;
    if (!stripped.includes(CAPABILITY_REFERENCE)) {
      issues.push(
        `${path}: exposes a graph confirmation path without referencing ${CAPABILITY_REFERENCE} (FR-010, R-09)`,
      );
    }
  }
  return issues;
}

/* v8 ignore start -- CLI wiring; findUncappedConfirmExposures above is unit tested */
if (isMainModule(import.meta.url)) {
  const result = await runGate('gate-graph-confirm-capability', () => {
    const issues = findUncappedConfirmExposures(collectConfirmSurfaceFiles());
    if (issues.length > 0) throw new Error(issues.join('; '));
  });
  reportAndExit(result);
}
/* v8 ignore stop */
