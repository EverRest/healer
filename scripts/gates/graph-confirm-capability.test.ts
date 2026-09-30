import { describe, expect, it } from 'vitest';
import {
  collectConfirmSurfaceFiles,
  findUncappedConfirmExposures,
} from './graph-confirm-capability.mjs';

describe('gate-graph-confirm-capability (004 T015, FR-010, R-09)', () => {
  it('fails on an MCP tool that confirms a draft without referencing the capability', () => {
    const issues = findUncappedConfirmExposures([
      {
        path: 'apps/mcp-server/src/tools/graph.ts',
        content: "registerTool({ name: 'graph_confirm_draft', handler: async () => {} });",
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('apps/mcp-server/src/tools/graph.ts');
    expect(issues[0]).toContain('GRAPH_CONFIRM_CAPABILITY');
  });

  it('fails on a command interface named ConfirmDraftItems with no capability reference', () => {
    const issues = findUncappedConfirmExposures([
      {
        path: 'packages/domain/architecture/src/application/commands/confirm-draft-items.ts',
        content: 'export async function confirmDraftItems(input: unknown) { return input; }',
      },
    ]);
    expect(issues).toHaveLength(1);
  });

  it('fails on a job handler processing a graph:confirm job type with no capability reference', () => {
    const issues = findUncappedConfirmExposures([
      {
        path: 'apps/worker/src/handlers/graph-confirm.ts',
        content: "export const JOB_TYPE = 'graph:confirm';",
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

  it('ignores a mention of confirmation inside a comment', () => {
    const issues = findUncappedConfirmExposures([
      {
        path: 'apps/api/src/issues/issues.controller.ts',
        content: '// never 403, which would itself confirm the issueId exists\nexport {};',
      },
    ]);
    expect(issues).toEqual([]);
  });

  it('is silent on ordinary code naming neither graph nor draft confirmation', () => {
    const issues = findUncappedConfirmExposures([
      {
        path: 'apps/worker/src/handlers/close-issue.ts',
        content: 'export async function closeIssue(id: string) { return id; }',
      },
    ]);
    expect(issues).toEqual([]);
  });

  it('the current repository exposes no graph confirmation path yet (necessarily vacuous, 004 T015)', () => {
    expect(findUncappedConfirmExposures(collectConfirmSurfaceFiles())).toEqual([]);
  });
});
