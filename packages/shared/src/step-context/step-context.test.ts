import { describe, expect, it } from 'vitest';
import { currentStep, withStep } from './index.js';

describe('step-context (001 FR-008, R-06)', () => {
  it('is undefined outside any step scope', () => {
    expect(currentStep()).toBeUndefined();
  });

  it('reports the step bound by withStep for the duration of the callback', () => {
    withStep('collector', () => {
      expect(currentStep()).toBe('collector');
    });
    expect(currentStep()).toBeUndefined();
  });

  it('nests correctly — the inner step is visible only within its own callback', () => {
    withStep('outer', () => {
      expect(currentStep()).toBe('outer');
      withStep('inner', () => {
        expect(currentStep()).toBe('inner');
      });
      expect(currentStep()).toBe('outer');
    });
  });

  it('propagates across an await inside the callback', async () => {
    await withStep('diagnose', async () => {
      await Promise.resolve();
      expect(currentStep()).toBe('diagnose');
    });
  });

  it('returns whatever withStep returns', () => {
    expect(withStep('collector', () => 42)).toBe(42);
  });
});
