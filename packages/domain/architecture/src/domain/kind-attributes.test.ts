import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHARACTERISTICS,
  defaultCharacteristicVocabulary,
  parseCharacteristicVocabulary,
} from './characteristics.js';
import {
  validateComponentAttr,
  validateDeploymentUnitAttr,
  validateEndpointAttr,
  validateRepositoryAttr,
} from './kind-attributes.js';

const vocab = defaultCharacteristicVocabulary();

describe('T044: characteristics vocabulary comes from configuration, not migration', () => {
  it('the default vocabulary carries the data-model terms', () => {
    for (const t of [
      'stateful',
      'user_facing',
      'money_path',
      'public_contract',
      'scheduled',
      'third_party',
    ])
      expect(DEFAULT_CHARACTERISTICS).toContain(t);
  });

  it('extending the vocabulary is a configuration value — no code or migration change', () => {
    const extended = parseCharacteristicVocabulary([...DEFAULT_CHARACTERISTICS, 'pii_bearing']);
    expect(
      validateComponentAttr(
        { componentType: 'service', characteristics: ['pii_bearing'] },
        extended,
      ).ok,
    ).toBe(true);
    expect(
      validateComponentAttr({ componentType: 'service', characteristics: ['pii_bearing'] }, vocab)
        .ok,
    ).toBe(false);
  });

  it.each([
    ['not an array', 'stateful'],
    ['empty', []],
    ['duplicate term', ['stateful', 'stateful']],
    ['not snake_case', ['User-Facing']],
    ['non-string', [1]],
    ['empty string', ['']],
  ])('rejects a malformed vocabulary config: %s', (_label, raw) => {
    expect(() => parseCharacteristicVocabulary(raw)).toThrow(/characteristic vocabulary/i);
  });

  it('accepts a component with a narrow type and known characteristics, deduplicated', () => {
    const r = validateComponentAttr(
      {
        componentType: 'service',
        characteristics: ['stateful', 'money_path', 'stateful'],
        ownerRef: 'team-a',
      },
      vocab,
    );
    expect(r).toMatchObject({
      ok: true,
      value: {
        componentType: 'service',
        characteristics: ['stateful', 'money_path'],
        ownerRef: 'team-a',
      },
    });
  });

  it('rejects an unknown characteristic by name', () => {
    const r = validateComponentAttr(
      { componentType: 'service', characteristics: ['stateful', 'cool'] },
      vocab,
    );
    expect(r).toEqual({ ok: false, errors: [expect.stringContaining('cool')] });
  });

  it('rejects a component type outside the narrow list', () => {
    const r = validateComponentAttr({ componentType: 'microservice', characteristics: [] }, vocab);
    expect(r.ok).toBe(false);
  });

  it('has no field for an architecture style: an extra key is refused, not ignored (FR-001, D-09)', () => {
    const r = validateComponentAttr(
      { componentType: 'service', characteristics: [], architectureStyle: 'monolith' } as never,
      vocab,
    );
    expect(r).toEqual({ ok: false, errors: [expect.stringContaining('architectureStyle')] });
  });

  it('an external component is an ordinary component type', () => {
    expect(
      validateComponentAttr({ componentType: 'external', characteristics: ['third_party'] }, vocab)
        .ok,
    ).toBe(true);
  });
});

describe('T045: the other kind attributes validate their closed lists', () => {
  it('deployment_unit_attr accepts a function runtime and refuses an unknown one', () => {
    const base = { environment: 'production', runtimeRef: 'fn-1' };
    expect(validateDeploymentUnitAttr({ ...base, runtimeKind: 'function' }).ok).toBe(true);
    expect(validateDeploymentUnitAttr({ ...base, runtimeKind: 'lpar' }).ok).toBe(false);
    expect(validateDeploymentUnitAttr({ ...base, runtimeKind: 'vm', environment: '' }).ok).toBe(
      false,
    );
    expect(validateDeploymentUnitAttr({ ...base, runtimeKind: 'vm', extra: 1 } as never).ok).toBe(
      false,
    );
  });

  it('repository_attr requires vcs, project and branch', () => {
    const ok = { vcs: 'gitlab', projectRef: 'g/p', defaultBranch: 'main' };
    expect(validateRepositoryAttr(ok).ok).toBe(true);
    expect(validateRepositoryAttr({ ...ok, vcs: 'svn' }).ok).toBe(false);
    expect(validateRepositoryAttr({ ...ok, projectRef: '' }).ok).toBe(false);
    expect(validateRepositoryAttr({ ...ok, extra: 1 } as never).ok).toBe(false);
  });

  it('endpoint_attr takes a protocol; method, path and contract are optional', () => {
    expect(
      validateEndpointAttr({ protocol: 'http', method: 'GET', pathTemplate: '/x' }),
    ).toMatchObject({
      ok: true,
      value: { protocol: 'http', method: 'GET', pathTemplate: '/x', contractRef: null },
    });
    expect(validateEndpointAttr({ protocol: 'soap' }).ok).toBe(false);
    expect(validateEndpointAttr({ protocol: 'cli', extra: 1 } as never).ok).toBe(false);
  });

  it('collects every error rather than the first', () => {
    const r = validateRepositoryAttr({ vcs: 'svn', projectRef: '', defaultBranch: '' });
    expect(r.ok === false && r.errors.length).toBe(3);
  });
});

describe('optional text fields and whitespace (review M1, M2)', () => {
  it.each([
    ['ownerRef', 42],
    ['ownerRef', {}],
    ['ownerRef', '   '],
    ['ownerRef', ''],
  ])('component %s = %j is a validation error, not a silent null', (field, value) => {
    const r = validateComponentAttr(
      { componentType: 'service', characteristics: [], [field]: value },
      vocab,
    );
    expect(r).toEqual({ ok: false, errors: [expect.stringContaining(field)] });
  });

  it('undefined and null are the only "absent" values; a text value is trimmed', () => {
    const base = { componentType: 'service', characteristics: [] };
    expect(validateComponentAttr({ ...base, ownerRef: undefined }, vocab)).toMatchObject({
      ok: true,
      value: { ownerRef: null },
    });
    expect(validateComponentAttr({ ...base, ownerRef: null }, vocab)).toMatchObject({
      ok: true,
      value: { ownerRef: null },
    });
    expect(validateComponentAttr({ ...base, ownerRef: ' team-a ' }, vocab)).toMatchObject({
      ok: true,
      value: { ownerRef: 'team-a' },
    });
  });

  it('endpoint and deployment-unit optional fields reject non-strings', () => {
    expect(validateEndpointAttr({ protocol: 'http', method: 5 }).ok).toBe(false);
    expect(validateEndpointAttr({ protocol: 'http', pathTemplate: '  ' }).ok).toBe(false);
    expect(validateEndpointAttr({ protocol: 'http', contractRef: false }).ok).toBe(false);
    expect(
      validateDeploymentUnitAttr({
        environment: 'prod',
        runtimeKind: 'vm',
        runtimeRef: 'r',
        currentVersion: 7,
      }).ok,
    ).toBe(false);
  });

  it('whitespace-only required text is rejected', () => {
    expect(
      validateDeploymentUnitAttr({ environment: '  ', runtimeKind: 'vm', runtimeRef: 'r' }).ok,
    ).toBe(false);
    expect(
      validateDeploymentUnitAttr({ environment: 'p', runtimeKind: 'vm', runtimeRef: ' \t' }).ok,
    ).toBe(false);
    expect(
      validateRepositoryAttr({ vcs: 'gitlab', projectRef: ' ', defaultBranch: 'main' }).ok,
    ).toBe(false);
    expect(validateRepositoryAttr({ vcs: 'gitlab', projectRef: 'p', defaultBranch: '  ' }).ok).toBe(
      false,
    );
  });
});
