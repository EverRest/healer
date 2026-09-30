import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTICS_DUMP_NAME,
  diagnosticsFilePath,
  PIDFILE_NAME,
  pidFilePath,
} from './diagnostics-paths.js';

describe('diagnostics-paths (012 T048 review — the one authority for these two filenames)', () => {
  it('builds the pidfile path under the given diagnostics directory', () => {
    expect(pidFilePath('/tmp/x')).toBe(`/tmp/x/${PIDFILE_NAME}`);
  });

  it('builds the dump file path under the given diagnostics directory', () => {
    expect(diagnosticsFilePath('/tmp/x')).toBe(`/tmp/x/${DIAGNOSTICS_DUMP_NAME}`);
  });

  it('the two names are distinct', () => {
    expect(PIDFILE_NAME).not.toBe(DIAGNOSTICS_DUMP_NAME);
  });
});
