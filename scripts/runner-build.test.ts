import { describe, expect, it } from 'vitest';
import { assertNotRebuildInPlace, readRunnerVersion } from './runner-build.mjs';

describe('runner-build: version from apps/runner/package.json (012 T049/T050, FR-017)', () => {
  it('reads the version field', () => {
    expect(readRunnerVersion(JSON.stringify({ version: '0.5.0' }))).toBe('0.5.0');
  });

  it('fails loudly when the version field is missing', () => {
    expect(() => readRunnerVersion(JSON.stringify({}))).toThrow(/no version field/);
  });

  it('fails loudly when the version field is empty', () => {
    expect(() => readRunnerVersion(JSON.stringify({ version: '' }))).toThrow(/no version field/);
  });
});

describe('runner-build: refuses to rebuild a published tag in place (FR-017, ADR 0014)', () => {
  it('passes when no previous image exists at this tag — a first release', () => {
    expect(() =>
      assertNotRebuildInPlace('healer-runner:0.5.0', undefined, 'sha256:new'),
    ).not.toThrow();
  });

  it('passes when the rebuild reproduces the same digest — a legitimate no-op', () => {
    expect(() =>
      assertNotRebuildInPlace('healer-runner:0.5.0', 'sha256:same', 'sha256:same'),
    ).not.toThrow();
  });

  it('refuses when the rebuild produces a different digest at the same tag', () => {
    expect(() =>
      assertNotRebuildInPlace('healer-runner:0.5.0', 'sha256:old', 'sha256:new'),
    ).toThrow(/refusing to rebuild in place/);
  });

  it('names the tag and both digests in the refusal message', () => {
    expect(() =>
      assertNotRebuildInPlace('healer-runner:0.5.0', 'sha256:old', 'sha256:new'),
    ).toThrow(/healer-runner:0\.5\.0.*sha256:old.*sha256:new/s);
  });
});
