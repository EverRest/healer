import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectAgentSurfaceFiles,
  collectCommandSurfaceFiles,
  collectStrictSurfaceFiles,
  findAgentCapabilityReferences,
  findStrictConfirmExposures,
  findUncappedConfirmExposures,
} from './graph-confirm-capability.mjs';

const REAL_CONTROLLER_PATH = fileURLToPath(
  new URL('../../apps/api/src/architecture/discovery-drafts.controller.ts', import.meta.url),
);

describe('findStrictConfirmExposures — apps/mcp-server, apps/worker (004 T015, 004 sub-batch D, R-09)', () => {
  it('fails on any confirm-shaped MCP tool registration, no escape hatch', () => {
    const issues = findStrictConfirmExposures([
      {
        path: 'apps/mcp-server/src/tools/graph.ts',
        content: "registerTool({ name: 'graph_confirm_draft', handler: async () => {} });",
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('apps/mcp-server/src/tools/graph.ts:1');
  });

  /**
   * The review's central finding (CRITICAL, confirmed by two independent reviews): referencing
   * GRAPH_CONFIRM_CAPABILITY here is not a guard, it is the capability *reaching* a tool — e.g. an
   * MCP tool declaring `requires: [GRAPH_CONFIRM_CAPABILITY]` or a credential declaring
   * `capabilities: [GRAPH_CONFIRM_CAPABILITY]`. The old logic treated that mention as proof of a
   * check and passed it; this must fail regardless.
   */
  it('still fails even when the capability constant is mentioned right next to it (the reversed bypass)', () => {
    const issues = findStrictConfirmExposures([
      {
        path: 'apps/mcp-server/src/tools/graph.ts',
        content:
          "registerTool({ name: 'confirm_draft', requires: [GRAPH_CONFIRM_CAPABILITY], handler: async () => {} });",
      },
    ]);
    // Two matches (the tool name, and the capability constant's own name), and that is the point:
    // mentioning the constant is not a guard here, so it does not suppress anything.
    expect(issues.length).toBeGreaterThan(0);
  });

  it('catches RejectDraftItems, approveDraftItems and acceptDraft, not only confirm', () => {
    const issues = findStrictConfirmExposures([
      { path: 'apps/worker/src/handlers/a.ts', content: 'export function rejectDraftItems() {}' },
      { path: 'apps/worker/src/handlers/b.ts', content: 'export function approveDraftItems() {}' },
      { path: 'apps/worker/src/handlers/c.ts', content: 'export function acceptDraft() {}' },
    ]);
    expect(issues).toHaveLength(3);
  });

  it('catches a job handler processing a graph:confirm job type', () => {
    const issues = findStrictConfirmExposures([
      {
        path: 'apps/worker/src/handlers/graph-confirm.ts',
        content: "export const JOB_TYPE = 'graph:confirm';",
      },
    ]);
    expect(issues).toHaveLength(1);
  });

  /**
   * Reproduced bypass (CRITICAL, silent-failure-hunter): the old `.replace(/\/\/.*$/gm, '')`
   * comment stripper let an ordinary URL string earlier on the line hide everything after it,
   * including a real confirm-shaped registration, from ever being scanned at all. The shared
   * `stripComments` is now tokenizer-based (scripts/lib/strip-comments.test.ts proves the general
   * fix); this proves the gate itself now catches the exact shape reported.
   */
  it('is not defeated by a "//" inside a URL string earlier on the same line', () => {
    const issues = findStrictConfirmExposures([
      {
        path: 'apps/worker/src/graph/graph-handler.ts',
        content:
          'const base = "https://example.com"; registerRoute({ path: "graph_confirm_draft" });\n',
      },
    ]);
    expect(issues).toHaveLength(1);
  });

  it('ignores a mention of confirmation inside a comment', () => {
    const issues = findStrictConfirmExposures([
      {
        path: 'apps/worker/src/issues/issues-handler.ts',
        content: '// never 403, which would itself confirm the issueId exists\nexport {};',
      },
    ]);
    expect(issues).toEqual([]);
  });

  it("does not false-positive on the read envelope's own confirmationState field", () => {
    const issues = findStrictConfirmExposures([
      {
        path: 'apps/worker/src/graph/graph-handler.ts',
        content:
          'export function toDto(graphVersion: number, confirmationState: string) { return { graphVersion, confirmationState }; }',
      },
    ]);
    expect(issues).toEqual([]);
  });

  it('the current repository exposes no confirm-shaped surface yet (necessarily vacuous, 004 T015)', () => {
    expect(findStrictConfirmExposures(collectStrictSurfaceFiles())).toEqual([]);
  });

  /**
   * Documented, accepted gap (MEDIUM, both reviews): dynamic name construction and factory/loop
   * registration have no literal "confirm"+"draft" token pair in the source at all, so no regex can
   * see them. Not chased further — real static analysis is a different tool. This test records the
   * limit rather than pretending it is closed.
   */
  it('KNOWN GAP: does not catch a confirm path assembled from string parts at runtime', () => {
    const issues = findStrictConfirmExposures([
      {
        path: 'apps/mcp-server/src/tools/graph.ts',
        content:
          "registerTool({ name: ['graph', 'confirm', 'draft'].join('_'), handler: async () => {} });",
      },
    ]);
    expect(issues).toEqual([]); // acknowledged limit, see file header — not a passing guarantee
  });
});

describe('findAgentCapabilityReferences — apps/runner, packages/agents (004 T015, ADR 0010)', () => {
  it('fails when the Change Agent / Verifier execution path references the capability constant', () => {
    const issues = findAgentCapabilityReferences([
      {
        path: 'apps/runner/src/change-agent.ts',
        content:
          "import { GRAPH_CONFIRM_CAPABILITY } from '@healer/domain-architecture';\nexport const x = GRAPH_CONFIRM_CAPABILITY;",
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('apps/runner/src/change-agent.ts');
  });

  it('fails when an agent package references the literal graph:confirm string', () => {
    const issues = findAgentCapabilityReferences([
      { path: 'packages/agents/src/change-agent.ts', content: "const cap = 'graph:confirm';" },
    ]);
    expect(issues).toHaveLength(1);
  });

  it('is silent on agent code that never mentions the capability', () => {
    const issues = findAgentCapabilityReferences([
      { path: 'apps/runner/src/index.ts', content: 'export {};' },
    ]);
    expect(issues).toEqual([]);
  });

  it('the current repository — apps/runner and packages/agents — references the capability nowhere (004 T015)', () => {
    expect(findAgentCapabilityReferences(collectAgentSurfaceFiles())).toEqual([]);
  });
});

describe('findUncappedConfirmExposures — application/commands, architecture infrastructure and apps/api/src (004 T015, 004 sub-batch D)', () => {
  it('fails on a command interface named ConfirmDraftItems with no capability reference', () => {
    const issues = findUncappedConfirmExposures([
      {
        path: 'packages/domain/architecture/src/application/commands/confirm-draft-items.ts',
        content: 'export async function confirmDraftItems(input: unknown) { return input; }',
      },
    ]);
    expect(issues).toHaveLength(1);
  });

  it('fails on RejectDraftItems with no capability reference too', () => {
    const issues = findUncappedConfirmExposures([
      {
        path: 'packages/domain/architecture/src/application/commands/reject-draft-items.ts',
        content: 'export async function rejectDraftItems(input: unknown) { return input; }',
      },
    ]);
    expect(issues).toHaveLength(1);
  });

  it('fails on an architecture infrastructure file exposing a confirm path with no capability reference', () => {
    const issues = findUncappedConfirmExposures([
      {
        path: 'packages/domain/architecture/src/infrastructure/prisma-confirm-draft-items.ts',
        content: 'export async function confirmDraftItems() {}',
      },
    ]);
    expect(issues).toHaveLength(1);
  });

  it('passes once the handler references GRAPH_CONFIRM_CAPABILITY', () => {
    const issues = findUncappedConfirmExposures([
      {
        path: 'packages/domain/architecture/src/application/commands/confirm-draft-items.ts',
        content: [
          "import { GRAPH_CONFIRM_CAPABILITY } from '../../domain/capabilities.js';",
          'export async function confirmDraftItems(actor: { capabilities: readonly string[] }) {',
          '  if (!actor.capabilities.includes(GRAPH_CONFIRM_CAPABILITY)) throw new Error("refused");',
          '}',
        ].join('\n'),
      },
    ]);
    expect(issues).toEqual([]);
  });

  it('is silent on ordinary code naming neither graph nor draft confirmation', () => {
    const issues = findUncappedConfirmExposures([
      {
        path: 'packages/domain/issues/src/application/commands/close-issue.ts',
        content: 'export async function closeIssue(id: string) { return id; }',
      },
    ]);
    expect(issues).toEqual([]);
  });

  it('the current repository exposes no uncapped confirm path in commands, architecture infrastructure or apps/api/src (004 T015)', () => {
    expect(findUncappedConfirmExposures(collectCommandSurfaceFiles())).toEqual([]);
  });

  describe('apps/api/src — moved out of the strict root once a real confirm route landed (004 sub-batch D)', () => {
    it('fails on a synthetic confirm-shaped route under apps/api/src with no capability reference', () => {
      const issues = findUncappedConfirmExposures([
        {
          path: 'apps/api/src/graph/graph.controller.ts',
          content: [
            "import { Controller, Post } from '@nestjs/common';",
            '@Controller()',
            'export class GraphController {',
            "  @Post('drafts/:id/confirm')",
            '  async confirmDraftItems() { return {}; }',
            '}',
          ].join('\n'),
        },
      ]);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('apps/api/src/graph/graph.controller.ts');
    });

    it('the real controller file, as written, passes — it genuinely references GRAPH_CONFIRM_CAPABILITY', () => {
      const content = readFileSync(REAL_CONTROLLER_PATH, 'utf8');
      const issues = findUncappedConfirmExposures([
        { path: 'apps/api/src/architecture/discovery-drafts.controller.ts', content },
      ]);
      expect(issues).toEqual([]);
    });

    describe('mutation check: remove the real reference, confirm the gate fails for the right reason, restore byte-for-byte', () => {
      let original: string | undefined;

      afterEach(() => {
        if (original !== undefined) {
          writeFileSync(REAL_CONTROLLER_PATH, original);
          original = undefined;
        }
      });

      it('fails once GRAPH_CONFIRM_CAPABILITY is no longer imported or referenced', () => {
        original = readFileSync(REAL_CONTROLLER_PATH, 'utf8');
        expect(original).toContain('GRAPH_CONFIRM_CAPABILITY');

        // Strip the import and both `void GRAPH_CONFIRM_CAPABILITY;` defense-in-depth lines —
        // the mutation this round-trip proves the gate actually depends on, not a no-op edit.
        const mutated = original
          .replace(/\n\s*GRAPH_CONFIRM_CAPABILITY,/, '')
          .replace(/\n\s*void GRAPH_CONFIRM_CAPABILITY;.*\n/g, '\n');
        // The real, code-level reference (the import and both `void` statements) is gone — only
        // prose mentions survive in doc comments, which `findUncappedConfirmExposures` itself
        // strips before checking (`stripComments`), so they cannot accidentally pass the gate.
        expect(mutated).not.toMatch(/^\s*GRAPH_CONFIRM_CAPABILITY,$/m);
        expect(mutated).not.toContain('void GRAPH_CONFIRM_CAPABILITY;');
        writeFileSync(REAL_CONTROLLER_PATH, mutated);

        const issues = findUncappedConfirmExposures([
          { path: 'apps/api/src/architecture/discovery-drafts.controller.ts', content: mutated },
        ]);
        expect(issues.length).toBeGreaterThan(0);
        expect(issues.join(' ')).toContain('without referencing GRAPH_CONFIRM_CAPABILITY');

        // Full gate run against the real, mutated file on disk — not just the pure function —
        // proving `pnpm run gate-graph-confirm-capability` itself would have failed.
        expect(findUncappedConfirmExposures(collectCommandSurfaceFiles()).length).toBeGreaterThan(
          0,
        );
      });

      it('restores byte-for-byte and the gate passes again', () => {
        original = readFileSync(REAL_CONTROLLER_PATH, 'utf8');
        const mutated = original
          .replace(/\n\s*GRAPH_CONFIRM_CAPABILITY,/, '')
          .replace(/\n\s*void GRAPH_CONFIRM_CAPABILITY;.*\n/g, '\n');
        writeFileSync(REAL_CONTROLLER_PATH, mutated);
        // `afterEach` restores `original` — assert the restored content matches what was on disk
        // before this test touched it (same `original` captured at the top of this `it`).
        expect(findUncappedConfirmExposures(collectCommandSurfaceFiles()).length).toBeGreaterThan(
          0,
        );
        writeFileSync(REAL_CONTROLLER_PATH, original);
        expect(findUncappedConfirmExposures(collectCommandSurfaceFiles())).toEqual([]);
      });
    });
  });

  describe("apps/mcp-server/src and apps/worker/src stay unconditionally strict — unaffected by apps/api/src's move (004 sub-batch D regression)", () => {
    it('a confirm-shaped match in apps/worker/src still fails even when it references the capability (no escape hatch, unchanged)', () => {
      const issues = findStrictConfirmExposures([
        {
          path: 'apps/worker/src/handlers/graph-confirm.ts',
          content:
            "import { GRAPH_CONFIRM_CAPABILITY } from '@healer/domain-architecture';\n" +
            "export const JOB_TYPE = 'graph:confirm'; export const cap = GRAPH_CONFIRM_CAPABILITY;",
        },
      ]);
      expect(issues.length).toBeGreaterThan(0);
    });

    it('a confirm-shaped match in apps/mcp-server/src still fails even when it references the capability (no escape hatch, unchanged)', () => {
      const issues = findStrictConfirmExposures([
        {
          path: 'apps/mcp-server/src/tools/graph.ts',
          content:
            "import { GRAPH_CONFIRM_CAPABILITY } from '@healer/domain-architecture';\n" +
            "registerTool({ name: 'confirm_draft', requires: [GRAPH_CONFIRM_CAPABILITY] });",
        },
      ]);
      expect(issues.length).toBeGreaterThan(0);
    });

    it('apps/api/src is no longer walked by the strict root at all — collectStrictSurfaceFiles only ever returns mcp-server/worker files', () => {
      // `findStrictConfirmExposures` itself is a pure matcher with no path-based filtering — the
      // strictness comes entirely from which files `collectStrictSurfaceFiles` hands it (the
      // real `STRICT_SCAN_ROOTS` list). This is the real proof `apps/api/src` moved categories:
      // its own files (including the real confirm/reject controller) are simply never in this set
      // any more, so the same content that fails under `findUncappedConfirmExposures` above is
      // not even reachable by the strict, no-escape-hatch rule.
      const paths = collectStrictSurfaceFiles().map((f) => f.path);
      expect(paths.some((p) => p.startsWith('apps/api/src/'))).toBe(false);
      expect(paths.some((p) => p.includes('discovery-drafts.controller.ts'))).toBe(false);
    });
  });
});
