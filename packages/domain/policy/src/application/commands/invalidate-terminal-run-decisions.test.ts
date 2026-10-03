import { describe, expect, it } from 'vitest';
import type { TenantScoped } from '@healer/shared';
import { onIssueStateChanged } from './invalidate-terminal-run-decisions.js';

const TENANT = '00000000-0000-0000-8000-0000000000e2';
const ISSUE = '00000000-0000-0000-8000-0000000000e3';

// T077: the event names the issue and the tenant; the repository decides which decisions are bound
// to a terminal run (e2e: terminal-run-invalidation.e2e.test.ts).
describe('onIssueStateChanged', () => {
  const run = (name: string) => {
    const calls: TenantScoped<{ readonly issueId: string }>[] = [];
    const result = onIssueStateChanged(
      {
        invalidateForTerminalRuns: async (where) => {
          calls.push(where);
          return 2;
        },
      },
      { name, tenantId: TENANT, subjectId: ISSUE },
    );
    return { result, calls };
  };

  it('invalidates for the event’s own tenant and issue, and reports how many', async () => {
    const { result, calls } = run('IssueStateChanged');
    await expect(result).resolves.toBe(2);
    expect(calls).toEqual([{ tenantId: TENANT, issueId: ISSUE }]);
  });

  it('refuses an event it is not the consumer of, rather than invalidating on a wiring mistake', () => {
    const { result, calls } = (() => {
      try {
        return run('IssueResolved');
      } catch (error) {
        return { result: error, calls: [] };
      }
    })();
    expect(result).toBeInstanceOf(Error);
    expect(calls).toEqual([]);
  });
});
