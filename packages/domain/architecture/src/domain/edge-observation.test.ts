import { describe, expect, it } from 'vitest';
import type { EdgeObservation, MachineProvenanceClass } from './edge-observation.js';
import type { ProvenanceClass } from './provenance.js';

describe('EdgeObservation (004 T038)', () => {
  it('cannot express a human provenance class: the merge path has no actor reference', () => {
    const base: Omit<EdgeObservation, 'provenance'> = {
      fromNodeId: 'a',
      toNodeId: 'b',
      edgeType: 'depends_on',
      layer: 'code',
      observationRef: 'r',
      adapterKey: 'k',
      adapterVersion: '1',
      observationCount: 1,
      lastObservedAt: new Date(),
      observedUntil: new Date(),
      baseVersion: 1,
    };
    // @ts-expect-error human_confirmed is not a MachineProvenanceClass
    const human: EdgeObservation = { ...base, provenance: 'human_confirmed' };
    expect(human.provenance).toBe('human_confirmed');
  });

  it('MachineProvenanceClass is exactly the closed list minus the two human classes', () => {
    const machine = [
      'derived_from_trace',
      'derived_from_runtime',
      'derived_from_code',
      'derived_from_config',
      'inferred_from_convention',
    ] as const satisfies readonly MachineProvenanceClass[];
    const everyMachineClassListed: Exclude<
      MachineProvenanceClass,
      (typeof machine)[number]
    > extends never
      ? true
      : false = true;
    const noHumanClass: Extract<
      MachineProvenanceClass,
      'human_authored' | 'human_confirmed'
    > extends never
      ? true
      : false = true;
    const _closed: ProvenanceClass = machine[0];
    expect([everyMachineClassListed, noHumanClass, _closed]).toEqual([true, true, machine[0]]);
  });
});
