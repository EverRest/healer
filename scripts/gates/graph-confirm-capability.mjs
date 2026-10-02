#!/usr/bin/env node
// `gate-graph-confirm-capability` (004 T015, FR-010, R-09).
//
// "No agent credential carries `graph:confirm`; no MCP tool exposes confirmation"
// (graph-contract.md §5) is a fact about today's repository, not an enforcement mechanism — no
// capability or credential registry exists anywhere in this codebase yet (002-policy's to build,
// out of this feature's scope). This gate is a **best-effort structural drift detector**, not the
// real security boundary: the real enforcement is that whatever eventually mints an agent or
// automation credential simply never puts `'graph:confirm'` in its capability list. This scan
// exists to notice, before that code is built, if a confirm path shows up somewhere it shouldn't
// have been able to reach in the first place — and to keep noticing afterwards.
//
// Three different rules for three different places, because "exposes a confirm path" means
// something different depending on who is exposing it:
//
//  - `apps/mcp-server/src`, `apps/worker/src`: **nothing here may look like a graph confirmation
//    surface at all, yet** — no escape hatch. Referencing `GRAPH_CONFIRM_CAPABILITY` here would
//    not be a guard, it would be the capability *reaching* a tool or job; R-09 says no MCP tool
//    exposes confirmation, full stop, and that is a fact about *today's* repository, not
//    something a mention of the constant can excuse. **Unchanged by Phase 3** — nothing there may
//    ever look like a confirm surface, real routes or not.
//  - `apps/runner/src`, `packages/agents`: the Change Agent and Verifier execute here (ADR 0010).
//    This capability must never be referenced here at all, confirm-shaped surface or not — deciding
//    what a credential carries is the (not-yet-built) credential-issuing code's job, never the
//    agent's own.
//  - `packages/**/application/commands/**`, `packages/domain/architecture/src/infrastructure/**`
//    and, **as of 004 Phase 3's sub-batch D**, `apps/api/src`: a confirm-shaped handler is expected
//    here — `ConfirmDraftItems`/`RejectDraftItems` (`packages/domain/architecture`) and their real
//    HTTP surface, `DiscoveryDraftsController` (`apps/api/src/architecture/
//    discovery-drafts.controller.ts`, `POST /discovery/drafts/{draftId}/confirm` and `/reject`) —
//    legitimate once the file also references `GRAPH_CONFIRM_CAPABILITY`. `apps/api/src` moved out
//    of the strict, no-escape-hatch root above the moment a real confirm route landed there: before
//    Phase 3, "nothing here may look like one yet" was the correct rule for it; once a route
//    genuinely confirming a draft exists, the question stops being *whether* apps/api/src may
//    expose one and becomes *whether the one it exposes references the capability* — exactly what
//    `apps/mcp-server/src`/`apps/worker/src` are not yet allowed to ask, since neither has a real
//    confirm route today. A confirm-shaped match in `apps/api/src` with no such reference is the
//    actual regression this rule exists to catch.
//
// `apps/mcp-server/src`, `apps/worker/src` and `packages/agents`/`apps/runner/src` stay vacuous —
// nothing there currently mentions graph confirmation, by design (R-09). `apps/api/src` is no
// longer vacuous: it is expected to, and does, contain a real, capability-referencing confirm
// surface — the value here is what this rule catches the day that reference goes missing.
//
// Known, accepted limits of a textual scan (no attempt is made to chase these further — doing so
// properly needs real static analysis, which this is not):
//  - dynamic name construction (`'graph_' + 'confirm' + '_draft'`, `.join('_')`, a template built
//    from parts) will not be recognised as the pattern it assembles into;
//  - a tool/command registered through a factory or a loop (`for (const op of ['confirm', ...])`)
//    is invisible — there is no literal "confirm" token in the source at all;
//  - these are exactly the shapes a determined bypass would use, and no regex will close them.
//
// Comments are stripped with the same tokenizer-based `stripComments` `gate-architecture-agnostic`
// and `gate-isolation` use (`scripts/lib/strip-comments.mjs`) — string- and template-literal-aware,
// so an ordinary URL string earlier on the same line cannot hide a real match from this scan.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';
import { stripComments } from '../lib/strip-comments.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// No escape hatch: any confirm-shaped match here is a violation regardless of what else the file
// says (see file header). `apps/api/src` is deliberately NOT here — see file header for why
// Phase 3 moved it into the capped root below instead.
const STRICT_SCAN_ROOTS = ['apps/mcp-server/src', 'apps/worker/src'];

// The capability constant/string must never appear here at all (see file header).
const AGENT_SCAN_ROOTS = ['apps/runner/src', 'packages/agents'];

// Confirm-shaped matches here are legitimate once they reference the capability constant.
const COMMANDS_DIR_PATTERN = /(^|\/)application\/commands\//;
const ARCHITECTURE_INFRA_DIR = 'packages/domain/architecture/src/infrastructure';
// 004 Phase 3 sub-batch D: the real HTTP confirm/reject surface lives here
// (`DiscoveryDraftsController`) — walked wholesale, same treatment as `ARCHITECTURE_INFRA_DIR`.
const API_CAPPED_SCAN_ROOTS = ['apps/api/src'];

const CAPABILITY_REFERENCE = 'GRAPH_CONFIRM_CAPABILITY';
// `graph:confirm` written as a literal string, any quote style — the shape a hand-rolled credential
// or tool declaration would use instead of importing the constant.
const CAPABILITY_LITERAL_PATTERN = /['"`]graph:confirm['"`]/gi;

// `confirm`/`reject`/`approve`/`accept` paired with `draft`/`graph`, in either order, allowing at
// most one separator character (`_-.:`) or none (a camelCase transition needs none: `confirmDraft`).
// Word-bounded so this cannot match a substring of an unrelated longer identifier.
const ACTION = '(?:confirm|reject|approve|accept)';
const SUBJECT = '(?:draft|graph)';
const SEP = '[_.:-]?';
const CONFIRM_PATTERN_SOURCE = `\\b${ACTION}${SEP}${SUBJECT}\\w*|\\b${SUBJECT}${SEP}${ACTION}\\w*`;
function newConfirmPattern() {
  return new RegExp(CONFIRM_PATTERN_SOURCE, 'gi');
}

// The read envelope's own `confirmationState` field (004 T013) is not a confirmation path — mask it
// out before matching so it can never be confused for one, independently of how the pattern above
// is worded (docs/patterns.md: prefer unrepresentable, but a mask is the honest fallback for a
// textual scan). `graph.confirmationState` / `graphConfirmationState` are masked too.
const EXCLUDED_IDENTIFIER_PATTERN = /\b(?:graph[_.:-]?)?confirmationState\b/gi;
function maskExcludedIdentifiers(text) {
  return text.replace(EXCLUDED_IDENTIFIER_PATTERN, (m) => ' '.repeat(m.length));
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/* v8 ignore start -- CLI wiring (real fs walk); the pure functions below are unit tested */
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

function toFileEntries(paths) {
  return paths.map((path) => ({
    path: relative(REPO_ROOT, path),
    content: readFileSync(path, 'utf8'),
  }));
}

function collectFromRoots(roots) {
  const files = [];
  for (const root of roots) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    files.push(...walk(abs));
  }
  return toFileEntries(files);
}

export function collectStrictSurfaceFiles() {
  return collectFromRoots(STRICT_SCAN_ROOTS);
}

export function collectAgentSurfaceFiles() {
  return collectFromRoots(AGENT_SCAN_ROOTS);
}

export function collectCommandSurfaceFiles() {
  const packagesAbs = join(REPO_ROOT, 'packages');
  const packageFiles = existsSync(packagesAbs)
    ? [...walk(packagesAbs)].filter((path) => {
        const rel = relative(REPO_ROOT, path);
        return COMMANDS_DIR_PATTERN.test(rel) || rel.startsWith(`${ARCHITECTURE_INFRA_DIR}/`);
      })
    : [];
  return [...toFileEntries(packageFiles), ...collectFromRoots(API_CAPPED_SCAN_ROOTS)];
}
/* v8 ignore stop */

/**
 * `apps/mcp-server/src`, `apps/worker/src`, `apps/api/src` (004 T015, R-09): any confirm-shaped
 * match is a violation, with no way for the file to excuse it — see file header.
 * @param {{ path: string, content: string }[]} files
 */
export function findStrictConfirmExposures(files) {
  const issues = [];
  for (const { path, content } of files) {
    const stripped = maskExcludedIdentifiers(stripComments(content));
    for (const match of stripped.matchAll(newConfirmPattern())) {
      issues.push(
        `${path}:${lineOf(stripped, match.index)}: exposes a graph confirmation-shaped surface ` +
          `("${match[0]}") — nothing here may expose one yet (FR-010, R-09)`,
      );
    }
  }
  return issues;
}

/**
 * `apps/runner/src`, `packages/agents` (004 T015, R-09, ADR 0010): the capability must never be
 * referenced here, confirm-shaped surface or not — see file header.
 * @param {{ path: string, content: string }[]} files
 */
export function findAgentCapabilityReferences(files) {
  const issues = [];
  for (const { path, content } of files) {
    const stripped = stripComments(content);
    if (stripped.includes(CAPABILITY_REFERENCE)) {
      issues.push(
        `${path}: references ${CAPABILITY_REFERENCE} — agent/runner code must never carry a ` +
          `graph:confirm capability (R-09, ADR 0010)`,
      );
    }
    for (const match of stripped.matchAll(CAPABILITY_LITERAL_PATTERN)) {
      issues.push(
        `${path}:${lineOf(stripped, match.index)}: references the literal "graph:confirm" ` +
          `capability string — agent/runner code must never carry it (R-09, ADR 0010)`,
      );
    }
  }
  return issues;
}

/**
 * `packages/**\/application/commands/**`, `packages/domain/architecture/src/infrastructure/**`
 * (004 T015, FR-010, R-09): a confirm-shaped match is legitimate once the file also references
 * `GRAPH_CONFIRM_CAPABILITY` — the capability check a real handler is expected to make.
 * @param {{ path: string, content: string }[]} files
 */
export function findUncappedConfirmExposures(files) {
  const issues = [];
  for (const { path, content } of files) {
    const stripped = maskExcludedIdentifiers(stripComments(content));
    const matches = [...stripped.matchAll(newConfirmPattern())];
    if (matches.length === 0) continue;
    if (stripped.includes(CAPABILITY_REFERENCE)) continue;
    for (const match of matches) {
      issues.push(
        `${path}:${lineOf(stripped, match.index)}: exposes a graph confirmation path ` +
          `("${match[0]}") without referencing ${CAPABILITY_REFERENCE} (FR-010, R-09)`,
      );
    }
  }
  return issues;
}

/* v8 ignore start -- CLI wiring; the three functions above are unit tested */
if (isMainModule(import.meta.url)) {
  const result = await runGate('gate-graph-confirm-capability', () => {
    const issues = [
      ...findStrictConfirmExposures(collectStrictSurfaceFiles()),
      ...findAgentCapabilityReferences(collectAgentSurfaceFiles()),
      ...findUncappedConfirmExposures(collectCommandSurfaceFiles()),
    ];
    if (issues.length > 0) throw new Error(issues.join('; '));
  });
  reportAndExit(result);
}
/* v8 ignore stop */
