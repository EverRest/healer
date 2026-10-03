import { describe, expect, it } from 'vitest';
import {
  assertEveryRootScanned,
  findArchitectureLeaks,
  isScannedFile,
} from './architecture-agnostic.mjs';

describe('gate-architecture-agnostic (012 T032, constitution VII, 004 SC-008)', () => {
  it('fails when a domain type names a customer deployment style', () => {
    const issues = findArchitectureLeaks([
      {
        path: 'packages/domain/architecture/src/index.ts',
        content: "export type DeploymentStyle = 'kubernetes' | 'serverless';",
      },
    ]);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain('kubernetes');
    expect(issues[1]).toContain('serverless');
  });

  it('fails on a monolith/microservice conditional branch', () => {
    const issues = findArchitectureLeaks([
      {
        path: 'packages/domain/architecture/src/graph.ts',
        content: "if (style === 'monolith') { /* ... */ } else if (style === 'microservices') {}",
      },
    ]);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('ignores a mention inside a comment', () => {
    const issues = findArchitectureLeaks([
      {
        path: 'packages/domain/architecture/src/index.ts',
        content: '// this package must never mention kubernetes or serverless\nexport const x = 1;',
      },
    ]);
    expect(issues).toEqual([]);
  });

  it('is exempt inside an adapters/ or discovery/ directory', () => {
    const issues = findArchitectureLeaks([
      {
        path: 'packages/domain/architecture/src/adapters/kubernetes.ts',
        content: "export const KUBERNETES_LABEL = 'kubernetes';",
      },
      {
        path: 'packages/domain/architecture/src/discovery/serverless-scanner.ts',
        content: 'export function scanServerless() {}',
      },
    ]);
    expect(issues).toEqual([]);
  });

  it('is silent on ordinary domain code naming no architecture style', () => {
    const issues = findArchitectureLeaks([
      {
        path: 'packages/domain/issues/src/index.ts',
        content: 'export interface Issue { readonly id: string; }',
      },
    ]);
    expect(issues).toEqual([]);
  });

  it('fails when a domain type names our own stack (redundant with T035, second independent check)', () => {
    const issues = findArchitectureLeaks([
      {
        path: 'packages/domain/issues/src/index.ts',
        content: "import { PrismaClient } from '@prisma/client';",
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('prisma');
    expect(issues[0]).toContain('own stack');
  });

  it('is exempt for own-stack vocabulary inside infrastructure/', () => {
    const issues = findArchitectureLeaks([
      {
        path: 'packages/domain/issues/src/infrastructure/repository.ts',
        content: "import { PrismaClient } from '@prisma/client'; // bullmq, redis, postgres",
      },
    ]);
    expect(issues).toEqual([]);
  });

  it('is exempt for a barrel re-export naming an infrastructure module by filename', () => {
    const issues = findArchitectureLeaks([
      {
        path: 'packages/domain/evidence/src/index.ts',
        content: "export * from './infrastructure/prisma-evidence-repository.js';",
      },
    ]);
    expect(issues).toEqual([]);
  });
});

describe('architecture-conditional branches (004 T050, SC-008, FR-020, 012 FR-002)', () => {
  const branch = (path: string, content: string) => findArchitectureLeaks([{ path, content }]);
  // The rule is the term, not the shape of the statement around it: any form of branching
  // (and any alias of a style) names the style somewhere.
  const branchIssues = branch;

  it.each([
    ["if (arch === 'monolith') {}"],
    ['if (arch !== "microservice") {}'],
    ["switch (kind) {\n  case 'serverless':\n    break;\n}"],
    ["const x = style == 'microservices' ? 1 : 2;"],
    ["const x = 'monolith' === arch;"],
    ['if (isServerless(system)) {}'],
    ['while (system.isMonolith) {}'],
    ["if (\n  arch ===\n  'monolith'\n) {}"],
    ["if (arch\n  === 'monolith') {}"],
    ['const h = { monolith: a, serverless: b }[style];'],
    ['const H = {\n monolith: runA,\n serverless: runB,\n};\nH[style]();'],
    ["const go = ['monolith','serverless'].includes(style) && run();"],
    ['isServerless(s) && doIt();'],
    ["handlers[arch]?.('monolith');"],
    ['const m = /monolith/i.test(arch);\nif (m) {}'],
    ['if (`${arch}` === `monolith`) {}'],
    ["strategies.get('serverless')?.run();"],
    ["const x = arch=='a'?'monolith':1;"],
    ["const x = cond\n  ? 'monolith'\n  : 'serverless';"],
    ["if (arch === 'lambdas') {}"],
    ['if (isMicroServices(x)) {}'],
    ["if (arch === 'micro-service') {}"],
    ["if (arch === 'micro services') {}"],
    ['if (isECS) {}'],
    ['if (ECSCluster) {}'],
    ['if (isAWSLambda) {}'],
    ["if ('serverless' in caps) {}"],
    ['if (isDockerSwarm) {}'],
    ['if (cond &&\n  isMonolith) {}'],
    ["const MONO = 'monolith';\nif (arch === MONO) {}"],
    ["enum S { Mono = 'monolith' }\nif (arch === S.Mono) {}"],
  ])('fails a style named anywhere outside packages/integrations: %s', (content) => {
    expect(branchIssues('apps/api/src/handler.ts', content)).not.toHaveLength(0);
    expect(branchIssues('packages/domain/architecture/src/domain/x.ts', content)).not.toHaveLength(
      0,
    );
  });

  it('fails a branch in an infrastructure/ directory too (that exemption is for own stack only)', () => {
    expect(
      branchIssues(
        'packages/domain/architecture/src/infrastructure/x.ts',
        "if (a === 'monolith') {}",
      ),
    ).not.toHaveLength(0);
  });

  it('passes the same text under packages/integrations/** (path pattern, any adapter)', () => {
    for (const adapter of ['kubernetes', 'gitlab', 'some-future-adapter']) {
      expect(
        branch(
          `packages/integrations/${adapter}/src/collect.ts`,
          "if (arch === 'monolith') {}\nswitch (k) { case 'serverless': break; }",
        ),
      ).toEqual([]);
    }
  });

  it('does not exempt a look-alike path', () => {
    for (const path of [
      'packages/integrations-shared/src/x.ts',
      'packages/integrations-foo/src/x.ts',
      'packages/integrationsX/x.ts',
      'packages/Integrations/x.ts',
      'apps/api/packages/integrations/x.ts',
    ]) {
      expect(branchIssues(path, "if (a === 'monolith') {}")).not.toHaveLength(0);
    }
  });

  it('applies the exemption and the scope to Windows separators too', () => {
    expect(branch('packages\\integrations\\k8s\\a.ts', "if (a === 'monolith') {}")).toEqual([]);
    expect(branch('apps\\api\\a.ts', "if (a === 'monolith') {}")).not.toHaveLength(0);
    expect(branch('packages\\domain\\x\\src\\a.ts', "const p = 'prisma';").join()).toContain(
      'own stack',
    );
  });

  it('scans every JS/TS source extension, never declarations or tests', () => {
    for (const f of ['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.js', 'a.mjs', 'a.cjs', 'a.jsx'])
      expect(isScannedFile(f)).toBe(true);
    for (const f of ['a.d.ts', 'a.test.ts', 'a.spec.tsx', 'a.test.mjs', 'a.json', 'a.md'])
      expect(isScannedFile(f)).toBe(false);
  });

  it('fails closed when a scan root yields no files', () => {
    expect(() =>
      assertEveryRootScanned([{ path: 'apps/api/a.ts' }], ['packages/domain', 'apps']),
    ).toThrow(/packages\/domain/);
    expect(() =>
      assertEveryRootScanned(
        [{ path: 'apps/api/a.ts' }, { path: 'packages/domain/b.ts' }],
        ['packages/domain', 'apps'],
      ),
    ).not.toThrow();
  });

  it('ignores a branch inside a comment, as the comment-stripping convention says', () => {
    expect(
      branch('apps/api/src/x.ts', "// if (arch === 'monolith') {}\n/* case 'serverless': */"),
    ).toEqual([]);
  });

  it('is silent on a branch that tests something else', () => {
    expect(
      branch('apps/api/src/x.ts', "if (kind === 'component') {}\nswitch (t) { case 'service': }"),
    ).toEqual([]);
  });
});
