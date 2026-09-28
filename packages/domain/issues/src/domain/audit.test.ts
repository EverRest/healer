import { describe, expectTypeOf, it } from 'vitest';
import type { NewAuditEntry } from './audit.js';

/**
 * `NewAuditEntry` ties `agentRunId` to `actorType === 'agent'` (001 T042 review, SC-007) — a
 * plain `agentRunId?: string` let `{ actorType: 'agent' }` with no `agentRunId` type-check,
 * silently promising a resolution `resolveAgentRunFacts` could never deliver, and let a
 * human/system/runner entry carry a meaningless `agentRunId` just as validly. Same proof style as
 * `link-repository.test.ts`'s tenant-scoping check: a real (never-invoked) construction attempt,
 * type-checked by `tsc --build`, not a runtime assertion a mock could fake.
 */
const AGENT_ENTRY_FIELDS = {
  id: 'entry-1',
  actorRef: 'investigator',
  action: 'issue.diagnose',
  targetType: 'issue',
  targetId: 'issue-1',
  reason: 'diagnosed root cause',
  evidenceIds: [],
  outcome: 'ok',
} as const;

/** Type-checked by `tsc --build`, never invoked — constructing these would be noise. */
function typeProofNeverConstructed(): void {
  // @ts-expect-error an 'agent' actor must carry a real agentRunId — SC-007's own guarantee
  const missingAgentRunId: NewAuditEntry = { ...AGENT_ENTRY_FIELDS, actorType: 'agent' };
  void missingAgentRunId;

  // @ts-expect-error a non-agent actor has nothing for agentRunId to resolve to
  const nonAgentWithAgentRunId: NewAuditEntry = {
    ...AGENT_ENTRY_FIELDS,
    actorType: 'human',
    agentRunId: 'run-1',
  };
  void nonAgentWithAgentRunId;
}
void typeProofNeverConstructed;

describe('NewAuditEntry ties agentRunId to actorType (001 T042 review, SC-007)', () => {
  it('an agent-action entry must carry a real agentRunId, not merely allow one', () => {
    expectTypeOf<
      Extract<NewAuditEntry, { actorType: 'agent' }>['agentRunId']
    >().toEqualTypeOf<string>();
  });
});
