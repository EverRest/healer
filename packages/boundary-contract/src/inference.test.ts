import { describe, expect, it } from 'vitest';
import {
  ControlPlaneDirective,
  INFERENCE_CAPABILITY,
  directiveRefusal,
  isPermittedInSimulationSession,
} from './index.js';

const agent: ControlPlaneDirective = {
  kind: 'agent_directive',
  agentKind: 'change',
  promptVersionId: 'pv1',
  promptDigest: 'd1',
  inputRefs: {},
  budget: { tokens: 1000, cost: 1, wallClockMs: 60000 },
  toolScope: [],
};

describe('directiveRefusal (012 T093, FR-046a, C-35, ADR 0010)', () => {
  it('refuses an agent_directive when the runner did not declare inference', () => {
    expect(directiveRefusal(agent, [])).toBe('inference_capability_missing');
    expect(directiveRefusal(agent, ['collection'])).toBe('inference_capability_missing');
  });

  it('accepts an agent_directive when inference is declared', () => {
    expect(directiveRefusal(agent, [INFERENCE_CAPABILITY])).toBeUndefined();
  });

  it('does not refuse other directive kinds for lack of inference', () => {
    const q: ControlPlaneDirective = { kind: 'capability_query', requested: [] };
    expect(directiveRefusal(q, [])).toBeUndefined();
  });

  it('regression pin of the existing .strict() shape (not T093 evidence): a credential-like field is rejected', () => {
    for (const field of ['apiKey', 'providerCredential', 'secret', 'token']) {
      expect(ControlPlaneDirective.safeParse({ ...agent, [field]: 'sk-123' }).success).toBe(false);
    }
    expect(ControlPlaneDirective.safeParse(agent).success).toBe(true);
  });

  it('leaves the simulation-session rule unchanged', () => {
    expect(isPermittedInSimulationSession(agent)).toBe(true);
    expect(isPermittedInSimulationSession({ ...agent, agentKind: 'investigator' })).toBe(false);
  });
});
