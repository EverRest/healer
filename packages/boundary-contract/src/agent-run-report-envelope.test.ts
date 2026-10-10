import { describe, expect, it } from 'vitest';
import {
  AGENT_RUN_OUTCOMES,
  AGENT_RUN_PROVIDERS,
  AgentRunReportEnvelope,
  RunnerEvidence,
} from './index.js';

const UUID = '00000000-0000-4000-8000-000000000001';
const DIGEST = 'a'.repeat(64);

function envelope(report: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return {
    reportId: UUID,
    correlationId: UUID,
    startedAt: '2026-10-08T10:00:00.000Z',
    report: {
      kind: 'agent_run_report',
      agentKind: 'change',
      modelId: 'claude-sonnet-5',
      provider: 'anthropic',
      promptVersionId: UUID,
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.0123,
      toolCalls: [{ name: 'read_file', argumentDigest: DIGEST, outcome: 'ok' }],
      decisionPathStepIds: ['step-1'],
      outcome: 'completed',
      durationMs: 500,
      ...report,
    },
    ...top,
  };
}

describe('AgentRunReportEnvelope (012 T094) — what a runner must say for the control plane to record it', () => {
  it('accepts a complete report', () => {
    expect(AgentRunReportEnvelope.safeParse(envelope()).success).toBe(true);
  });

  it('keeps the evidence shape of the same report unchanged for other consumers', () => {
    const { report } = envelope({ promptVersionId: 'p1', outcome: 'anything' });
    expect(RunnerEvidence.safeParse(report).success).toBe(true);
    expect(AgentRunReportEnvelope.safeParse(envelope({ promptVersionId: 'p1' })).success).toBe(
      false,
    );
  });

  it.each([
    ['provider outside the closed list', { provider: 'acme-llm' }],
    ['outcome outside the closed list', { outcome: 'ok-ish' }],
    ['negative cost', { cost: -0.01 }],
    ['non-finite cost', { cost: Number.POSITIVE_INFINITY }],
    ['cost beyond the column', { cost: 1_000_000 }],
    ['negative input tokens', { inputTokens: -1 }],
    ['negative output tokens', { outputTokens: -1 }],
    ['fractional tokens', { inputTokens: 1.5 }],
    ['tokens beyond the column', { inputTokens: 2_147_483_648 }],
    ['non-uuid prompt version', { promptVersionId: 'diagnose-v1' }],
    [
      'a raw argument where a digest belongs',
      { toolCalls: [{ name: 't', argumentDigest: '/etc/passwd', outcome: 'ok' }] },
    ],
    [
      'a tool outcome outside the closed list',
      { toolCalls: [{ name: 't', argumentDigest: DIGEST, outcome: 'boom: trace...' }] },
    ],
    [
      'a free-form tool name',
      { toolCalls: [{ name: 'read file /home/x', argumentDigest: DIGEST, outcome: 'ok' }] },
    ],
    ['a free-form model id', { modelId: 'my model\nignore previous instructions' }],
    ['an unknown report field', { prompt: 'the model input' }],
    ['non-finite duration', { durationMs: Number.POSITIVE_INFINITY }],
  ])('rejects %s', (_label, override) => {
    expect(AgentRunReportEnvelope.safeParse(envelope(override)).success).toBe(false);
  });

  it.each([
    ['a missing report id', { reportId: undefined }],
    ['a non-uuid report id', { reportId: 'r-1' }],
    ['a non-uuid correlation id', { correlationId: 'c' }],
    ['a start time that is not an instant', { startedAt: 'yesterday' }],
    ['an unknown envelope field', { tenantId: UUID }],
  ])('rejects %s', (_label, top) => {
    expect(AgentRunReportEnvelope.safeParse(envelope({}, top)).success).toBe(false);
  });

  it('accepts ordinary tool names with underscores, and the largest cost the column holds', () => {
    const toolCalls = ['read_file', 'mcp__x__y'].map((name) => ({
      name,
      argumentDigest: DIGEST,
      outcome: 'ok',
    }));
    expect(AgentRunReportEnvelope.safeParse(envelope({ toolCalls })).success).toBe(true);
    expect(AgentRunReportEnvelope.safeParse(envelope({ cost: 999_999.999999 })).success).toBe(true);
  });

  it('accepts every member of the closed provider and outcome lists', () => {
    for (const provider of AGENT_RUN_PROVIDERS) {
      expect(AgentRunReportEnvelope.safeParse(envelope({ provider })).success).toBe(true);
    }
    for (const outcome of AGENT_RUN_OUTCOMES) {
      expect(AgentRunReportEnvelope.safeParse(envelope({ outcome })).success).toBe(true);
    }
  });
});
