import { describe, expect, it } from 'vitest';
import {
  checkDumpIdentity,
  checkProcessLiveness,
  parsePidFileContent,
  resolvePidSource,
} from './runner-diagnostics.mjs';

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

describe('runner-diagnostics: parsePidFileContent (012 T048 review — JSON {pid, nonce}, not a bare integer)', () => {
  it('parses {pid, nonce} JSON', () => {
    expect(parsePidFileContent('{"pid": 4242, "nonce": "abc-123"}')).toEqual({
      pid: 4242,
      nonce: 'abc-123',
    });
  });

  it('trims surrounding whitespace/newlines', () => {
    expect(parsePidFileContent('\n{"pid": 4242, "nonce": "abc-123"}\n')).toEqual({
      pid: 4242,
      nonce: 'abc-123',
    });
  });

  it('tolerates a missing nonce field (an older-format or hand-written pidfile) by reporting nonce as undefined, not by fabricating one', () => {
    expect(parsePidFileContent('{"pid": 4242}')).toEqual({ pid: 4242, nonce: undefined });
  });

  it('fails loudly on invalid JSON rather than signalling pid 0/NaN', () => {
    expect(() => parsePidFileContent('')).toThrow(/does not contain valid JSON/);
    expect(() => parsePidFileContent('not-json')).toThrow(/does not contain valid JSON/);
  });

  it('fails loudly on JSON with a missing, non-numeric, zero or negative pid', () => {
    expect(() => parsePidFileContent('{}')).toThrow(/does not contain a valid PID/);
    expect(() => parsePidFileContent('{"pid": "4242"}')).toThrow(/does not contain a valid PID/);
    expect(() => parsePidFileContent('{"pid": 0}')).toThrow(/does not contain a valid PID/);
    expect(() => parsePidFileContent('{"pid": -1}')).toThrow(/does not contain a valid PID/);
  });

  it('rejects a non-string nonce rather than silently coercing it', () => {
    expect(() => parsePidFileContent('{"pid": 4242, "nonce": 123}')).toThrow(
      /nonce.*must be a string/,
    );
  });
});

describe('runner-diagnostics: checkProcessLiveness (012 T048 review — ESRCH vs EPERM, not one collapsed "not alive")', () => {
  it("reports the current process (this test's own pid) as alive, via the real OS check", () => {
    expect(checkProcessLiveness(process.pid)).toEqual({ status: 'alive' });
  });

  it('reports an implausibly large pid as not-found, via the real OS check', () => {
    expect(checkProcessLiveness(2 ** 30)).toEqual({ status: 'not-found' });
  });

  it('maps an injected ESRCH to not-found', () => {
    const killFn = () => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    };
    expect(checkProcessLiveness(4242, killFn)).toEqual({ status: 'not-found' });
  });

  it('maps an injected EPERM to permission-denied — a process exists, it just cannot be signalled by this user', () => {
    const killFn = () => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    };
    expect(checkProcessLiveness(4242, killFn)).toEqual({ status: 'permission-denied' });
  });

  it('rethrows an unrecognised error rather than silently reporting "not alive" for an unrelated failure', () => {
    const killFn = () => {
      throw Object.assign(new Error('kill EINVAL'), { code: 'EINVAL' });
    };
    expect(() => checkProcessLiveness(4242, killFn)).toThrow('kill EINVAL');
  });
});

describe('runner-diagnostics: checkDumpIdentity (012 T048 review — the core fix: liveness alone is not identity)', () => {
  it('passes when the dump carries the exact expected nonce', () => {
    expect(checkDumpIdentity('nonce-1', { processNonce: 'nonce-1' })).toEqual({ ok: true });
  });

  it('fails clearly when the dump carries a different nonce — a recycled pid now naming an unrelated process', () => {
    const result = checkDumpIdentity('nonce-1', { processNonce: 'nonce-2' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/does not match the signalled process/);
    expect(result.message).toContain('nonce-1');
  });

  it('fails clearly when the dump has no processNonce at all', () => {
    const result = checkDumpIdentity('nonce-1', {});
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/does not match the signalled process/);
  });

  it('is skipped (reports ok) when there was no expected nonce to compare against — an explicit PID/RUNNER_PID override, not resolved via a pidfile', () => {
    expect(checkDumpIdentity(undefined, { processNonce: 'anything' })).toEqual({ ok: true });
  });
});
