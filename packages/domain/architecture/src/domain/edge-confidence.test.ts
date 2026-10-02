import { describe, expect, it } from 'vitest';
import {
  type ConfidenceInput,
  DEFAULT_CONFIDENCE_CONFIG,
  deriveEdgeConfidence,
  resolveConfidenceConfig,
} from './edge-confidence.js';

const NOW = new Date('2026-10-02T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const derive = (
  provenance: Parameters<typeof deriveEdgeConfidence>[0]['provenance'],
  observationCount: number,
  lastObservedAt: Date = NOW,
) => deriveEdgeConfidence({ provenance, observationCount, lastObservedAt }, NOW);

describe('deriveEdgeConfidence (004 T039, R-15)', () => {
  it('is an integer in 0-100', () => {
    for (const volume of [0, 1, 2, 10, 1000, 1e9]) {
      const c = derive('derived_from_trace', volume);
      expect(Number.isInteger(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(100);
    }
  });

  it('a single observation is an observation, not a fact: capped low whatever the class', () => {
    expect(derive('derived_from_trace', 1)).toBe(DEFAULT_CONFIDENCE_CONFIG.singleObservationCap);
    expect(derive('derived_from_trace', 1)).toBeLessThan(derive('derived_from_trace', 2));
  });

  it('rises with volume and saturates at the observation cap', () => {
    const c10 = derive('derived_from_code', 10);
    const c1000 = derive('derived_from_code', 1000);
    expect(c1000).toBeGreaterThan(c10);
    expect(derive('derived_from_code', 1e9)).toBe(
      DEFAULT_CONFIDENCE_CONFIG.base.derived_from_code + DEFAULT_CONFIDENCE_CONFIG.observationCap,
    );
  });

  it('keeps the provenance ordering at equal volume and recency', () => {
    const order = [
      'derived_from_trace',
      'derived_from_runtime',
      'derived_from_code',
      'derived_from_config',
      'inferred_from_convention',
    ] as const;
    const scores = order.map((p) => derive(p, 50));
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(new Set(scores).size).toBe(order.length);
  });

  it('decays with 30-day periods since the last supporting observation, at write time', () => {
    const fresh = derive('derived_from_trace', 50, NOW);
    expect(derive('derived_from_trace', 50, daysAgo(29))).toBe(fresh);
    expect(derive('derived_from_trace', 50, daysAgo(30))).toBe(
      fresh - DEFAULT_CONFIDENCE_CONFIG.stalenessPerPeriod,
    );
    expect(derive('derived_from_trace', 50, daysAgo(10_000))).toBe(
      fresh - DEFAULT_CONFIDENCE_CONFIG.stalenessCap,
    );
  });

  it('never leaves 0-100, even with a hostile tenant configuration', () => {
    const wild = resolveConfidenceConfig({
      base: { derived_from_trace: 100 },
      observationCap: 100,
    });
    expect(
      deriveEdgeConfidence(
        { provenance: 'derived_from_trace', observationCount: 1e9, lastObservedAt: NOW },
        NOW,
        wild,
      ),
    ).toBe(100);
    const low = resolveConfidenceConfig({
      base: { inferred_from_convention: 0 },
      stalenessCap: 100,
    });
    expect(
      deriveEdgeConfidence(
        {
          provenance: 'inferred_from_convention',
          observationCount: 5,
          lastObservedAt: daysAgo(10_000),
        },
        NOW,
        low,
      ),
    ).toBe(0);
  });

  it('a per-tenant override changes the result; absent override is the default', () => {
    expect(resolveConfidenceConfig(null)).toEqual(DEFAULT_CONFIDENCE_CONFIG);
    const tuned = resolveConfidenceConfig({ base: { derived_from_trace: 55 } });
    expect(tuned.base.derived_from_code).toBe(DEFAULT_CONFIDENCE_CONFIG.base.derived_from_code);
    expect(
      deriveEdgeConfidence(
        { provenance: 'derived_from_trace', observationCount: 50, lastObservedAt: NOW },
        NOW,
        tuned,
      ),
    ).toBe(55 + 20);
  });

  it('rejects an override that is not a set of known integers in range', () => {
    expect(() => resolveConfidenceConfig({ base: { derived_from_trace: 101 } })).toThrow();
    expect(() => resolveConfidenceConfig({ base: { derived_from_trace: 0.5 } })).toThrow();
    expect(() => resolveConfidenceConfig({ base: { human_confirmed: 90 } })).toThrow();
    expect(() => resolveConfidenceConfig({ unknownKnob: 1 })).toThrow();
    expect(() => resolveConfidenceConfig('90')).toThrow();
  });

  it('takes no confidence from the caller: the input type has no such field', () => {
    const selfReported = {
      provenance: 'derived_from_trace' as const,
      observationCount: 5,
      lastObservedAt: NOW,
      // @ts-expect-error a model's self-reported confidence is not an input
      confidence: 99,
    } satisfies ConfidenceInput;
    expect(deriveEdgeConfidence(selfReported, NOW)).toBe(derive('derived_from_trace', 5));
  });
});
