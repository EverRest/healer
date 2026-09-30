import { describe, expect, it } from 'vitest';
import { isProcessAlive, parsePidFileContent, resolvePidSource } from './runner-diagnostics.mjs';

describe('runner-diagnostics: resolvePidSource (012 T048 — precedence: arg > RUNNER_PID > pidfile)', () => {
  it('prefers an explicit PID argument over everything else', () => {
    expect(
      resolvePidSource({ argv: ['node', 'script.mjs', '4242'], env: { RUNNER_PID: '9999' } }),
    ).toEqual({ kind: 'pid', pid: 4242 });
  });

  it('falls back to RUNNER_PID when no argument is given', () => {
    expect(resolvePidSource({ argv: ['node', 'script.mjs'], env: { RUNNER_PID: '4242' } })).toEqual(
      { kind: 'pid', pid: 4242 },
    );
  });

  it('falls back to a pidfile path when neither is given', () => {
    expect(
      resolvePidSource({ argv: ['node', 'script.mjs'], env: { RUNNER_PIDFILE: '/tmp/x.pid' } }),
    ).toEqual({ kind: 'pidfile', path: '/tmp/x.pid' });
  });

  it('rejects a non-numeric PID argument rather than silently signalling the wrong process', () => {
    expect(() => resolvePidSource({ argv: ['node', 'script.mjs', 'not-a-pid'], env: {} })).toThrow(
      /invalid PID argument/,
    );
  });

  it('rejects a non-numeric RUNNER_PID', () => {
    expect(() =>
      resolvePidSource({ argv: ['node', 'script.mjs'], env: { RUNNER_PID: 'MARKER-NOT-A-PID' } }),
    ).toThrow(/invalid RUNNER_PID/);
  });
});

describe('runner-diagnostics: parsePidFileContent', () => {
  it('parses a plain integer, trimming surrounding whitespace', () => {
    expect(parsePidFileContent('  4242\n')).toBe(4242);
  });

  it('fails loudly on a non-numeric or empty pidfile rather than signalling pid 0/NaN', () => {
    expect(() => parsePidFileContent('')).toThrow(/does not contain a valid PID/);
    expect(() => parsePidFileContent('not-a-pid')).toThrow(/does not contain a valid PID/);
    expect(() => parsePidFileContent('-1')).toThrow(/does not contain a valid PID/);
    expect(() => parsePidFileContent('0')).toThrow(/does not contain a valid PID/);
  });
});

describe('runner-diagnostics: isProcessAlive', () => {
  it("reports the current process (this test's own pid) as alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('reports an implausibly large pid as not alive rather than throwing', () => {
    expect(isProcessAlive(2 ** 30)).toBe(false);
  });
});
