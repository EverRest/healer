import { describe, expect, it } from 'vitest';
import {
  collectAgentSurfaceFiles,
  collectCommandSurfaceFiles,
  collectStrictSurfaceFiles,
  findAgentCapabilityReferences,
  findStrictConfirmExposures,
  findUncappedConfirmExposures,
} from './graph-confirm-capability.mjs';

describe('findStrictConfirmExposures — apps/mcp-server, apps/worker, apps/api (004 T015, R-09)', () => {
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
        path: 'apps/api/src/graph/graph.controller.ts',
        content:
          'const base = "https://example.com"; registerRoute({ path: "graph_confirm_draft" });\n',
      },
    ]);
    expect(issues).toHaveLength(1);
  });

  it('ignores a mention of confirmation inside a comment', () => {
    const issues = findStrictConfirmExposures([
      {
        path: 'apps/api/src/issues/issues.controller.ts',
        content: '// never 403, which would itself confirm the issueId exists\nexport {};',
      },
    ]);
    expect(issues).toEqual([]);
  });

  it("does not false-positive on the read envelope's own confirmationState field", () => {
    const issues = findStrictConfirmExposures([
      {
        path: 'apps/api/src/graph/graph.controller.ts',
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

describe('findUncappedConfirmExposures — application/commands and architecture infrastructure (004 T015)', () => {
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

  it('the current repository exposes no uncapped confirm path in commands or architecture infrastructure (004 T015)', () => {
    expect(findUncappedConfirmExposures(collectCommandSurfaceFiles())).toEqual([]);
  });
});
