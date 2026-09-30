import { describe, expect, it } from 'vitest';
import {
  computeAllowedStoreKeys,
  isPackageStoreEntry,
  shouldPruneStoreEntry,
} from './prune-runner-store.mjs';

describe('prune-runner-store: computeAllowedStoreKeys (012 T050 review)', () => {
  it('collects a store key from a plain dependency path', () => {
    const listing = [
      {
        name: '@healer/runner',
        dependencies: {
          zod: {
            version: '3.25.76',
            path: '/repo/node_modules/.pnpm/zod@3.25.76/node_modules/zod',
          },
        },
      },
    ];
    expect(computeAllowedStoreKeys(listing)).toEqual(new Set(['zod@3.25.76']));
  });

  it('collects a scoped, peer-suffixed store key exactly as pnpm names it', () => {
    const listing = [
      {
        name: '@healer/shared',
        dependencies: {
          '@opentelemetry/sdk-node': {
            version: '0.222.0',
            path: '/repo/node_modules/.pnpm/@opentelemetry+sdk-node@0.222.0_@opentelemetry+api@1.9.1/node_modules/@opentelemetry/sdk-node',
          },
        },
      },
    ];
    expect(computeAllowedStoreKeys(listing)).toEqual(
      new Set(['@opentelemetry+sdk-node@0.222.0_@opentelemetry+api@1.9.1']),
    );
  });

  it('recurses into nested dependencies', () => {
    const listing = [
      {
        name: '@healer/runner',
        dependencies: {
          '@healer/boundary-contract': {
            version: 'link:../../packages/boundary-contract',
            path: '/repo/packages/boundary-contract',
            dependencies: {
              zod: {
                version: '3.25.76',
                path: '/repo/node_modules/.pnpm/zod@3.25.76/node_modules/zod',
              },
            },
          },
        },
      },
    ];
    expect(computeAllowedStoreKeys(listing)).toEqual(new Set(['zod@3.25.76']));
  });

  it('ignores a workspace-linked dependency itself — its path never matches the store pattern', () => {
    const listing = [
      {
        name: '@healer/runner',
        dependencies: {
          '@healer/shared': {
            version: 'link:../../packages/shared',
            path: '/repo/packages/shared',
          },
        },
      },
    ];
    expect(computeAllowedStoreKeys(listing)).toEqual(new Set());
  });

  it('collects a store key from optionalDependencies too, not just dependencies (012 T050 review — a real optional dep would otherwise be pruned as unreachable)', () => {
    const listing = [
      {
        name: '@healer/runner',
        dependencies: {},
        optionalDependencies: {
          fsevents: {
            version: '2.3.3',
            path: '/repo/node_modules/.pnpm/fsevents@2.3.3/node_modules/fsevents',
          },
        },
      },
    ];
    expect(computeAllowedStoreKeys(listing)).toEqual(new Set(['fsevents@2.3.3']));
  });

  it('recurses into a nested optionalDependencies map, not just a nested dependencies map', () => {
    const listing = [
      {
        name: '@healer/runner',
        dependencies: {
          '@healer/boundary-contract': {
            version: 'link:../../packages/boundary-contract',
            path: '/repo/packages/boundary-contract',
            optionalDependencies: {
              fsevents: {
                version: '2.3.3',
                path: '/repo/node_modules/.pnpm/fsevents@2.3.3/node_modules/fsevents',
              },
            },
          },
        },
      },
    ];
    expect(computeAllowedStoreKeys(listing)).toEqual(new Set(['fsevents@2.3.3']));
  });

  it('merges keys across multiple projects', () => {
    const listing = [
      {
        name: '@healer/runner',
        dependencies: {
          zod: {
            version: '3.25.76',
            path: '/repo/node_modules/.pnpm/zod@3.25.76/node_modules/zod',
          },
        },
      },
      {
        name: '@healer/shared',
        dependencies: {
          pino: {
            version: '9.14.0',
            path: '/repo/node_modules/.pnpm/pino@9.14.0/node_modules/pino',
          },
        },
      },
    ];
    expect(computeAllowedStoreKeys(listing)).toEqual(new Set(['zod@3.25.76', 'pino@9.14.0']));
  });
});

describe('prune-runner-store: isPackageStoreEntry', () => {
  it('recognises a plain versioned entry', () => {
    expect(isPackageStoreEntry('zod@3.25.76')).toBe(true);
  });

  it('recognises a scoped, peer-suffixed entry', () => {
    expect(isPackageStoreEntry('@opentelemetry+sdk-node@0.222.0_@opentelemetry+api@1.9.1')).toBe(
      true,
    );
  });

  it('never flags pnpm store bookkeeping', () => {
    expect(isPackageStoreEntry('lock.yaml')).toBe(false);
    expect(isPackageStoreEntry('node_modules')).toBe(false);
  });
});

describe('prune-runner-store: shouldPruneStoreEntry (012 T050 review — the actual gate)', () => {
  const allowed = new Set(['zod@3.25.76', 'pino@9.14.0']);

  it('prunes a versioned entry not in the allowed set — the @prisma/client leak this exists for', () => {
    expect(shouldPruneStoreEntry('@prisma+client@6.19.3_prisma@6.19.3', allowed)).toBe(true);
  });

  it('keeps a versioned entry that is in the allowed set', () => {
    expect(shouldPruneStoreEntry('zod@3.25.76', allowed)).toBe(false);
  });

  it('never prunes store bookkeeping, even though it is trivially "not in the allowed set"', () => {
    expect(shouldPruneStoreEntry('lock.yaml', allowed)).toBe(false);
    expect(shouldPruneStoreEntry('node_modules', allowed)).toBe(false);
  });
});
