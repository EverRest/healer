import { describe, expect, it } from 'vitest';
import {
  ControlPlaneDirective,
  DirectiveEnvelope,
  RunnerEvidence,
  isPermittedInSimulationSession,
} from './index.js';

const VALID_ERROR_SIGNATURE = {
  kind: 'error_signature',
  exceptionType: 'TypeError',
  frames: ['a.ts:1', 'b.ts:2'],
  component: 'api',
  environment: 'production',
};

describe('RunnerEvidence — the closed evidence shape set (012 T040, R-04)', () => {
  it('accepts a valid error_signature', () => {
    expect(RunnerEvidence.parse(VALID_ERROR_SIGNATURE).kind).toBe('error_signature');
  });

  it('rejects a free-form string field not in the declared shape', () => {
    expect(() =>
      RunnerEvidence.parse({ ...VALID_ERROR_SIGNATURE, message: 'raw stack trace text here' }),
    ).toThrow();
  });

  it('rejects an unrecognized kind — the list is closed, not extensible at the call site', () => {
    expect(() => RunnerEvidence.parse({ kind: 'raw_log_body', text: 'anything' })).toThrow();
  });

  it('rejects a free-form field added to a discovery shape (T016) — the schema set stays closed', () => {
    expect(() =>
      RunnerEvidence.parse({
        kind: 'component_candidate',
        naturalKey: 'svc:api',
        name: 'api',
        componentType: 'service',
        characteristics: [],
        sourcePaths: ['api/'],
        adapterKey: 'gitlab',
        adapterVersion: '0.1.0',
        notes: 'anything',
      }),
    ).toThrow();
  });

  it('rejects a tool_output_summary field value that smuggles a raw log body under a plausible key', () => {
    expect(() =>
      RunnerEvidence.parse({
        kind: 'tool_output_summary',
        toolName: 'grep',
        outcome: 'ok',
        fields: { excerpt: 'x'.repeat(501) },
      }),
    ).toThrow();
  });

  it('rejects a tool_output_summary with more declared fields than the cap', () => {
    const fields = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]));
    expect(() =>
      RunnerEvidence.parse({
        kind: 'tool_output_summary',
        toolName: 'grep',
        outcome: 'ok',
        fields,
      }),
    ).toThrow();
  });

  it('accepts every declared shape at least once', () => {
    const samples: unknown[] = [
      VALID_ERROR_SIGNATURE,
      {
        kind: 'trace_shape',
        spans: [{ name: 's', durationMs: 1, serviceEdge: 'a->b', statusCode: 'OK' }],
      },
      {
        kind: 'metric_delta',
        seriesId: 's',
        window: '5m',
        baseline: 1,
        observed: 2,
        direction: 'up',
      },
      {
        kind: 'deploy_ref',
        deploymentId: 'd',
        version: '1.0.0',
        occurredAt: '2026-01-01T00:00:00Z',
        component: 'api',
      },
      {
        kind: 'commit_ref',
        sha: 'abc',
        authorHandle: 'x',
        occurredAt: '2026-01-01T00:00:00Z',
        changedPaths: ['a.ts'],
      },
      { kind: 'test_result', testId: 't1', outcome: 'pass', durationMs: 10 },
      { kind: 'file_path', path: 'a/b.ts' },
      { kind: 'tool_output_summary', toolName: 'grep', outcome: 'ok', fields: { count: 3 } },
      { kind: 'collection_gap', what: 'log body', why: 'unredactable', withheldByRedaction: true },
      {
        kind: 'component_candidate',
        naturalKey: 'svc:api',
        name: 'api',
        componentType: 'service',
        characteristics: ['stateful', 'public_contract'],
        ownerRef: 'team-platform',
        sourcePaths: ['api/'],
        adapterKey: 'gitlab',
        adapterVersion: '0.1.0',
      },
      {
        kind: 'deployment_unit_candidate',
        naturalKey: 'deploy:api-prod',
        environment: 'production',
        runtimeKind: 'kubernetes',
        runtimeRef: 'deployment/api',
        currentVersion: '1.2.3',
        lastDeployedAt: '2026-01-01T00:00:00Z',
      },
      {
        kind: 'dependency_observation',
        fromNaturalKey: 'svc:api',
        toNaturalKey: 'svc:billing',
        edgeType: 'calls',
        layer: 'runtime',
        provenance: 'derived_from_trace',
        observationCount: 5,
        firstObservedAt: '2026-01-01T00:00:00Z',
        lastObservedAt: '2026-01-02T00:00:00Z',
        windowSeconds: 3600,
      },
      {
        kind: 'repository_ref',
        projectRef: 'group/api',
        defaultBranch: 'main',
        headSha: 'abc123',
        componentNaturalKeys: ['svc:api'],
      },
      {
        kind: 'pull_request_ref',
        pullRequestId: 'pr1',
        sourceBranch: 'feat',
        targetBranch: 'main',
        state: 'open',
        reviewState: 'approved',
        authorHandle: 'x',
        occurredAt: '2026-01-01T00:00:00Z',
        changedPaths: ['a.ts'],
      },
      {
        kind: 'config_key_ref',
        keyPath: 'DB_URL',
        component: 'api',
        environment: 'prod',
        presence: 'present',
        type: 'string',
        lengthClass: 'short',
      },
      {
        kind: 'knowledge_ref',
        documentId: 'k1',
        path: 'docs/x.md',
        sectionAnchor: '#intro',
        contentDigest: 'abc',
        revision: '1',
        authorshipClass: 'human',
        observedAt: '2026-01-01T00:00:00Z',
      },
      { kind: 'stack_frame', path: 'a.ts', symbolName: 'foo', line: 10, frameIndex: 0 },
      {
        kind: 'change_plan_proposal',
        primaryFiles: ['a.ts'],
        dependentFiles: [],
        testPaths: ['a.test.ts'],
        impactClass: 'low',
        expectedBehaviorRef: 'eb1',
      },
      {
        kind: 'masking_candidate',
        path: 'a.ts',
        hunkLineRange: { start: 1, end: 5 },
        maskingClass: 'secret',
      },
      {
        kind: 'verification_verdict',
        verdict: 'GREEN',
        anchorsAvailable: ['eb1'],
        anchorsUsed: ['eb1'],
      },
      {
        kind: 'test_binding_ref',
        testId: 't1',
        path: 'a.test.ts',
        expectationId: 'eb1',
        expectationVersion: 1,
      },
      {
        kind: 'agent_run_report',
        agentKind: 'change',
        modelId: 'm1',
        provider: 'anthropic',
        promptVersionId: 'p1',
        inputTokens: 100,
        outputTokens: 50,
        cost: 0.01,
        toolCalls: [{ name: 'read_file', argumentDigest: 'abc', outcome: 'ok' }],
        decisionPathStepIds: ['s1'],
        outcome: 'completed',
        durationMs: 500,
      },
      {
        kind: 'change_graph',
        nodes: [{ path: 'a.ts', symbolName: 'foo' }],
        edges: [{ from: 'a', to: 'b', relation: 'calls', derivation: 'call_graph' }],
      },
    ];
    for (const sample of samples) {
      expect(() => RunnerEvidence.parse(sample), JSON.stringify(sample)).not.toThrow();
    }
    expect(samples).toHaveLength(23);
  });
});

describe('ControlPlaneDirective', () => {
  it('rejects a shell command shape — the control plane never sends one', () => {
    expect(() =>
      ControlPlaneDirective.parse({ kind: 'shell_command', command: 'rm -rf /' }),
    ).toThrow();
  });

  it('rejects a change_plan carrying patch content instead of the approved file list', () => {
    expect(() =>
      ControlPlaneDirective.parse({
        kind: 'change_plan',
        patch: '--- a.ts\n+++ b.ts',
        filesPermitted: ['a.ts'],
        regressionTestLocation: 'a.test.ts',
        anchorRef: 'eb1',
        limits: { wallClockMs: 1000 },
      }),
    ).toThrow();
  });
});

describe('DirectiveEnvelope (012 T051 — the wire shape a heartbeat response carries directives in)', () => {
  it('accepts an id paired with a valid directive', () => {
    const parsed = DirectiveEnvelope.parse({
      id: 'd1',
      directive: { kind: 'capability_query', requested: ['inference'] },
    });
    expect(parsed.id).toBe('d1');
    expect(parsed.directive.kind).toBe('capability_query');
  });

  it('rejects an envelope with no id — the identifier the contract assumes exists', () => {
    expect(() =>
      DirectiveEnvelope.parse({ directive: { kind: 'capability_query', requested: [] } }),
    ).toThrow();
  });

  it('rejects an envelope whose directive is not one of the closed seven shapes', () => {
    expect(() =>
      DirectiveEnvelope.parse({ id: 'd1', directive: { kind: 'shell_command' } }),
    ).toThrow();
  });
});

describe('isPermittedInSimulationSession (011, C-10)', () => {
  it('never permits remediation_directive', () => {
    expect(
      isPermittedInSimulationSession(
        ControlPlaneDirective.parse({
          kind: 'remediation_directive',
          actionKey: 'restart',
          target: 't',
          parameters: {},
        }),
      ),
    ).toBe(false);
  });

  it('rejects agent_directive.inputRefs carrying an undeclared key', () => {
    expect(() =>
      ControlPlaneDirective.parse({
        kind: 'agent_directive',
        agentKind: 'change',
        promptVersionId: 'p1',
        promptDigest: 'd1',
        inputRefs: { issueRef: 'i1', rawSourceExcerpt: 'smuggled' },
        budget: { tokens: 1, cost: 1, wallClockMs: 1 },
        toolScope: [],
      }),
    ).toThrow();
  });

  it('permits agent_directive for change and verifier, not for investigator', () => {
    const base = {
      kind: 'agent_directive' as const,
      promptVersionId: 'p1',
      promptDigest: 'd1',
      inputRefs: {},
      budget: { tokens: 1, cost: 1, wallClockMs: 1 },
      toolScope: [],
    };
    expect(isPermittedInSimulationSession({ ...base, agentKind: 'change' })).toBe(true);
    expect(isPermittedInSimulationSession({ ...base, agentKind: 'verifier' })).toBe(true);
    expect(isPermittedInSimulationSession({ ...base, agentKind: 'investigator' })).toBe(false);
  });

  it('permits everything else', () => {
    expect(
      isPermittedInSimulationSession(
        ControlPlaneDirective.parse({ kind: 'capability_query', requested: [] }),
      ),
    ).toBe(true);
  });
});
