import { describe, expect, it } from 'vitest';
import { findArchitectureLeaks } from './architecture-agnostic.mjs';

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
