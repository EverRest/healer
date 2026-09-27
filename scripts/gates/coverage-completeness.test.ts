import { describe, expect, it } from 'vitest';
import { findFilesMissingFromCoverage, isNoLogicStub } from './coverage-completeness.mjs';

describe('isNoLogicStub — the content-based exemption, not a path exclude list (FR-001)', () => {
  it('exempts the FR-001 entry-surface stub', () => {
    expect(isNoLogicStub('// @healer/domain-policy — entry surface.\nexport {};\n')).toBe(true);
  });

  it('exempts an empty file', () => {
    expect(isNoLogicStub('')).toBe(true);
  });

  it('exempts a file with only comments', () => {
    expect(isNoLogicStub('// nothing here yet\n/* still nothing */\n')).toBe(true);
  });

  it('does not exempt a file with real logic, however small', () => {
    expect(isNoLogicStub('export function isTenantScoped(x: unknown) { return !!x; }\n')).toBe(
      false,
    );
  });

  it('exempts a pure re-export barrel — it compiles to no statement v8 could ever instrument', () => {
    expect(isNoLogicStub("export * from './policy.js';\nexport * from './rule.js';\n")).toBe(true);
  });

  it('exempts a named re-export from another module', () => {
    expect(isNoLogicStub("export { boundExcerpt } from './excerpt.js';\n")).toBe(true);
  });

  it('exempts a file of only type/interface declarations — same reason, no runtime statement', () => {
    const content = `
      export type RefState = 'linked' | 'detached';
      export interface EvidenceLink {
        readonly id: string;
        readonly relation: 'supports' | 'contradicts';
      }
    `;
    expect(isNoLogicStub(content)).toBe(true);
  });

  it('does not exempt a file whose only export is a runtime constant', () => {
    expect(isNoLogicStub('export const MAX_LENGTH = 500;\n')).toBe(false);
  });

  it('does not exempt a file mixing type declarations with a real function', () => {
    const content = `
      export type Foo = string;
      export function doWork(x: Foo): boolean { return x.length > 0; }
    `;
    expect(isNoLogicStub(content)).toBe(false);
  });
});

describe('findFilesMissingFromCoverage — catches a real-logic file coverage.all:false made invisible (R-11)', () => {
  it('flags a real-logic file the coverage report never mentions', () => {
    const files = [
      { path: '/repo/packages/domain/policy/src/rule.ts', content: 'export const x = 1;' },
    ];
    expect(findFilesMissingFromCoverage(files, [])).toEqual([
      '/repo/packages/domain/policy/src/rule.ts',
    ]);
  });

  it('does not flag a file that appears in the coverage report', () => {
    const files = [{ path: '/repo/a.ts', content: 'export const x = 1;' }];
    expect(findFilesMissingFromCoverage(files, ['/repo/a.ts'])).toEqual([]);
  });

  it('does not flag a no-logic stub even when absent from the coverage report', () => {
    const files = [{ path: '/repo/index.ts', content: 'export {};' }];
    expect(findFilesMissingFromCoverage(files, [])).toEqual([]);
  });
});
