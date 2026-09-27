import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { isMainModule, reportAndExit, runGate } from './harness.mjs';

describe('gate harness (012 T018, T025, R-10)', () => {
  it('reports pass when the check completes', async () => {
    const result = await runGate('example', () => {});
    expect(result).toEqual({ gate: 'example', outcome: 'pass' });
  });

  it('fails, rather than skips, when the change set is not inspectable', async () => {
    const result = await runGate('example', () => {
      throw new Error('base commit unavailable');
    });
    expect(result).toEqual({ gate: 'example', outcome: 'fail', reason: 'base commit unavailable' });
  });

  it('has no third outcome a confused check could reach for', async () => {
    const result = await runGate('example', () => {
      throw 'not even an Error instance';
    });
    expect(['pass', 'fail']).toContain(result.outcome);
    expect(result.outcome).toBe('fail');
  });
});

describe('isMainModule (fails closed when a path is not inspectable)', () => {
  const original = process.argv[1];
  afterAll(() => {
    process.argv[1] = original;
  });

  it('matches a plain path', () => {
    process.argv[1] = '/repo/scripts/secret-scan.mjs';
    expect(isMainModule(pathToFileURL('/repo/scripts/secret-scan.mjs').href)).toBe(true);
  });

  it('matches a path containing a space — the case a literal `file://${argv[1]}` compare misses', () => {
    process.argv[1] = '/my code/scripts/secret-scan.mjs';
    const entryUrl = pathToFileURL('/my code/scripts/secret-scan.mjs').href;
    expect(entryUrl).not.toBe(`file://${process.argv[1]}`); // proves the old guard would have failed
    expect(isMainModule(entryUrl)).toBe(true);
  });

  it('does not match when invoked as an import rather than the entry script', () => {
    process.argv[1] = '/repo/scripts/other.mjs';
    expect(isMainModule(pathToFileURL('/repo/scripts/secret-scan.mjs').href)).toBe(false);
  });
});

describe('reportAndExit', () => {
  it('prints the result and sets a zero exit code on pass', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const originalExitCode = process.exitCode;
    reportAndExit({ gate: 'example', outcome: 'pass' });
    expect(write).toHaveBeenCalledWith('{"gate":"example","outcome":"pass"}\n');
    expect(process.exitCode).toBe(0);
    write.mockRestore();
    process.exitCode = originalExitCode;
  });

  it('sets a non-zero exit code on fail', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const originalExitCode = process.exitCode;
    reportAndExit({ gate: 'example', outcome: 'fail', reason: 'broke' });
    expect(process.exitCode).toBe(1);
    write.mockRestore();
    process.exitCode = originalExitCode;
  });
});
