import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_RUN_PROVIDERS, MAX_REPORTED_COST, agentRunReport } from '@healer/boundary-contract';
import { toCostDecimal } from '@healer/domain-policy';
import { AgentKind, CostProvenance, ExecutedIn, ProviderName } from '@healer/prisma-client';

// A closed list has exactly one authority. For the agent-run lists that authority is the database
// enum (schema.prisma); the boundary contract must restate some of them (it may not import Prisma)
// and the data model documents the rest. This is the reader that fails when any copy drifts.
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../${rel}`, import.meta.url)), 'utf8');

describe('agent-run closed lists agree with their authority (012 T094)', () => {
  it('the envelope accepts exactly the providers the database enum has', () => {
    expect([...AGENT_RUN_PROVIDERS].sort()).toEqual(Object.values(ProviderName).sort());
  });

  it('the report shape accepts exactly the agent kinds the database enum has', () => {
    expect([...agentRunReport.shape.agentKind.options].sort()).toEqual(
      Object.values(AgentKind).sort(),
    );
  });

  it('the envelope cost ceiling is exactly what the column holds', () => {
    expect(toCostDecimal(MAX_REPORTED_COST)).toBe('999999.999999');
    expect(() => toCostDecimal(MAX_REPORTED_COST + 0.000001)).toThrow();
  });

  it('data-model.md documents exactly the provenance and executed_in members', () => {
    const doc = read('specs/012-engineering-foundation/data-model.md');
    const listed = (name: string) =>
      [
        ...(doc.match(new RegExp(`\`${name}\` \\(([^)]*)\\)`))?.[1] ?? '').matchAll(/`([a-z_]+)`/g),
      ].map((m) => m[1]);
    expect(listed('cost_provenance')).toEqual(Object.values(CostProvenance));
    expect(listed('executed_in')).toEqual(Object.values(ExecutedIn));
  });

  it('there is no `measured` provenance until reported cost is reconciled against provider usage', () => {
    expect(Object.values(CostProvenance)).not.toContain('measured');
  });
});
