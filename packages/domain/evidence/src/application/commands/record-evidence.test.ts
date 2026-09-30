import { describe, expect, it } from 'vitest';
import { TenantContext } from '@healer/shared';
import {
  InvalidEvidencePayloadError,
  recordEvidence,
  UnrecognizedEvidenceKindError,
} from './record-evidence.js';
import type { Evidence } from '../../domain/types.js';
import type { EvidenceRepository, NewEvidence } from '../../domain/repository.js';

/**
 * `recordEvidence` (001 T027, FR-007, FR-007a): validates a raw payload against 012's boundary
 * schemas (`@healer/boundary-contract`'s `RunnerEvidence`) before it becomes a stored `Evidence`
 * row — `Evidence.payload`'s own doc comment ("schema-validated, no free-form strings... not
 * enforced by this type") named this gap, and this closes it. Maps every transport `kind` this
 * feature owns to its `Evidence.type` — FR-007a's own rule that the four architecture-discovery
 * shapes all persist as the single type `graph_fact`.
 */
const TENANT_ID = '00000000-0000-0000-8000-0000000000aa';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

function envelope(overrides: Partial<Parameters<typeof recordEvidence>[2]> = {}) {
  return {
    id: 'evidence-1',
    issueId: 'issue-1',
    sourceSystem: 'loki',
    sourceRef: 'ref1',
    sourceLabel: 'from logs',
    producedByStep: 'collector',
    observedAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2026-02-01T00:00:00Z'),
    ...overrides,
  };
}

function repoRecording(recorded: NewEvidence[]): EvidenceRepository {
  return {
    findById: async () => null,
    detach: () => Promise.reject(new Error('not used in this test')),
    listByIssue: () => Promise.reject(new Error('not used in this test')),
    record: async (evidence) => {
      recorded.push(evidence);
      return {
        ...evidence,
        tenantId: evidence.tenantId,
        refState: 'linked',
        receivedAt: new Date(),
      } as Evidence;
    },
  };
}

describe('recordEvidence (001 T027, FR-007, FR-007a)', () => {
  it('validates and records an error_signature payload as its own type', async () => {
    const recorded: NewEvidence[] = [];
    const payload = {
      kind: 'error_signature',
      exceptionType: 'NullPointerException',
      frames: ['at Checkout.charge'],
      component: 'checkout-service',
      environment: 'prod',
    };
    const evidence = await recordEvidence(repoRecording(recorded), CONTEXT, envelope(), payload);
    expect(evidence.type).toBe('error_signature');
    expect(recorded[0]?.payload).toMatchObject(payload);
  });

  it('maps all four architecture-discovery shapes to the single graph_fact type (FR-007a)', async () => {
    const cases: readonly unknown[] = [
      {
        kind: 'component_candidate',
        naturalKey: 'checkout',
        name: 'checkout',
        componentType: 'service',
        characteristics: [],
        sourcePaths: ['services/checkout'],
        adapterKey: 'gitlab',
        adapterVersion: '0.1.0',
      },
      {
        kind: 'deployment_unit_candidate',
        naturalKey: 'checkout-prod',
        environment: 'prod',
        runtimeKind: 'container',
        runtimeRef: 'checkout-prod',
        currentVersion: '1.0.0',
      },
      {
        kind: 'dependency_observation',
        fromNaturalKey: 'checkout',
        toNaturalKey: 'billing',
        edgeType: 'calls',
        layer: 'code',
        provenance: 'derived_from_code',
        observationCount: 3,
        firstObservedAt: '2026-01-01T00:00:00.000Z',
        lastObservedAt: '2026-01-30T00:00:00.000Z',
        windowSeconds: 2592000,
      },
      {
        kind: 'repository_ref',
        projectRef: 'repo-1',
        defaultBranch: 'main',
        headSha: 'a'.repeat(40),
        componentNaturalKeys: ['checkout'],
      },
    ];
    const recorded: NewEvidence[] = [];
    for (const payload of cases) {
      const evidence = await recordEvidence(repoRecording(recorded), CONTEXT, envelope(), payload);
      expect(evidence.type).toBe('graph_fact');
    }
  });

  it('rejects a payload that fails boundary validation, before it ever reaches the repository', async () => {
    const recorded: NewEvidence[] = [];
    const payload = { kind: 'error_signature', exceptionType: 'X' }; // missing required fields
    await expect(
      recordEvidence(repoRecording(recorded), CONTEXT, envelope(), payload),
    ).rejects.toBeInstanceOf(InvalidEvidencePayloadError);
    expect(recorded).toHaveLength(0);
  });

  it('rejects a kind this feature does not own as evidence (FR-007a — a new kind of evidence must be added here, not overloaded)', async () => {
    const recorded: NewEvidence[] = [];
    // agent_run_report is a real RunnerEvidence kind, but it becomes 012's own agent_run row
    // (ADR 0010), never an Evidence row — recordEvidence is not the place that decides that.
    const payload = {
      kind: 'agent_run_report',
      agentKind: 'investigator',
      modelId: 'x',
      provider: 'anthropic',
      promptVersionId: 'pv-1',
      inputTokens: 1,
      outputTokens: 1,
      cost: 0.1,
      toolCalls: [],
      decisionPathStepIds: [],
      outcome: 'ok',
      durationMs: 10,
    };
    await expect(
      recordEvidence(repoRecording(recorded), CONTEXT, envelope(), payload),
    ).rejects.toBeInstanceOf(UnrecognizedEvidenceKindError);
  });

  it('bounds an oversized excerpt and marks it truncated (R-05) — the same capture-time bounding T005 built', async () => {
    const recorded: NewEvidence[] = [];
    const huge = 'x'.repeat(200_000);
    await recordEvidence(repoRecording(recorded), CONTEXT, envelope({ excerpt: huge }), {
      kind: 'collection_gap',
      what: 'logs',
      why: 'rotated out',
      withheldByRedaction: false,
    });
    expect(recorded[0]?.excerptTruncated).toBe(true);
    expect(recorded[0]?.excerpt?.length).toBeLessThan(huge.length);
  });
});
