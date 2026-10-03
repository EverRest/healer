import { describe, expect, it } from 'vitest';
import {
  COLLECTOR_KEYS,
  COLLECTOR_PARAMETER_SCHEMAS,
  FOLLOW_UP_ONLY_COLLECTORS,
  ITEM_CLASSES,
  GAP_REASON_CODES,
} from '@healer/boundary-contract';
import {
  COLLECTOR_REGISTRY,
  declaredCollectors,
  describeParameterSchema,
} from './collector-registry.js';

describe('collector registry (003 T011, FR-005, R-12)', () => {
  it('declares exactly the closed collector list — no more, no fewer', () => {
    expect(Object.keys(COLLECTOR_REGISTRY).sort()).toEqual([...COLLECTOR_KEYS].sort());
    expect(declaredCollectors().map((c) => c.key)).toEqual([...COLLECTOR_KEYS]);
  });

  it('only lets a collector emit members of 012 shape set', () => {
    for (const c of declaredCollectors()) {
      expect(c.itemClasses.length).toBeGreaterThan(0);
      for (const klass of c.itemClasses) expect(ITEM_CLASSES).toContain(klass);
    }
  });

  it('shares the parameter schema with the boundary — one definition, not a copy', () => {
    for (const c of declaredCollectors()) {
      expect(c.parameterSchema).toBe(COLLECTOR_PARAMETER_SCHEMAS[c.key]);
    }
  });

  it('marks follow-up-only collectors from the boundary list and nowhere else', () => {
    const followUpOnly = declaredCollectors()
      .filter((c) => c.followUpOnly)
      .map((c) => c.key);
    expect(followUpOnly).toEqual([...FOLLOW_UP_ONLY_COLLECTORS]);
  });

  it('names a required capability per collector', () => {
    expect(COLLECTOR_REGISTRY.loki_logs.requiredCapability).toBe('collect:loki_logs');
  });

  it('describes a parameter schema by its declared field names', () => {
    expect(describeParameterSchema(COLLECTOR_REGISTRY.source_file.parameterSchema)).toEqual({
      fields: ['paths'],
    });
  });
});

describe('gap reason codes (003 T012, R-07)', () => {
  it('are exactly the nine closed codes of contracts/collection-plan.md', () => {
    expect([...GAP_REASON_CODES].sort()).toEqual(
      [
        'source_unreachable',
        'auth_revoked',
        'timeout',
        'retention_exceeded',
        'capability_unavailable',
        'budget_exhausted',
        'redaction_withheld',
        'schema_rejected',
        'empty_result',
      ].sort(),
    );
  });
});
