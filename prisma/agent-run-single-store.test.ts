import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 012 T060, FR-033, C-13, 001 FR-012: `agent_run` is the single store of the agent-run facts —
 * model, prompt version, tokens, cost. 001's `audit_entry` reaches them through `agent_run_id`
 * rather than duplicating them (it indexes every actor, agent_run indexes only agent
 * invocations — different key sets, same underlying facts live in exactly one place).
 *
 * The assertion is "no duplicate agent-run fields anywhere", not "only one table exists" — a
 * second table with its own unrelated columns is fine; a second table that also stores
 * `prompt_version_id`/`input_tokens`/`output_tokens`/`cost`/`model_id` is the violation.
 */
const SCHEMA_PATH = fileURLToPath(new URL('./schema.prisma', import.meta.url));

// The facts agent_run owns exclusively (data-model.md "Self-observation"), as Prisma field
// identifiers — not the mapped column name, which only exists for fields Prisma would otherwise
// rename (e.g. plain `cost` needs no `@map`, so searching for a quoted column name misses it).
const AGENT_RUN_FACT_FIELDS = ['promptVersionId', 'inputTokens', 'outputTokens', 'cost', 'modelId'];

function modelBlocks(schemaSource: string): { name: string; body: string }[] {
  const pattern = /model\s+(\w+)\s*\{([^}]*)\}/g;
  return [...schemaSource.matchAll(pattern)].map((m) => ({ name: m[1]!, body: m[2]! }));
}

function declaresField(body: string, field: string): boolean {
  return new RegExp(`^\\s*${field}\\s`, 'm').test(body);
}

describe('agent_run is the single store of the agent-run facts (012 T060)', () => {
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  const models = modelBlocks(schema);

  it('has an AgentRun model declaring the facts (sanity: the test itself is not vacuous)', () => {
    const agentRun = models.find((m) => m.name === 'AgentRun');
    expect(agentRun).toBeDefined();
    for (const field of AGENT_RUN_FACT_FIELDS) {
      expect(declaresField(agentRun!.body, field)).toBe(true);
    }
  });

  it('no other model declares any agent-run fact field', () => {
    const offenders: string[] = [];
    for (const model of models) {
      if (model.name === 'AgentRun') continue;
      for (const field of AGENT_RUN_FACT_FIELDS) {
        if (declaresField(model.body, field)) {
          offenders.push(`${model.name}.${field}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
