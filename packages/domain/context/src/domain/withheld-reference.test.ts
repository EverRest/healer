import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as domainContext from '../index.js';

/**
 * 003 T021, R-08, quickstart 8. A withheld item's `localRef` is a reference the control plane is
 * *structurally unable to dereference*: this is not a test that a lookup returns nothing, it is a
 * test that no lookup exists to call. There is no endpoint, no exported function, no table column
 * and no import that could resolve one — the ledger is a directory on the customer's storage, read
 * by a human inside their network (`make runner-resolve-ref`).
 */
const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'generated', 'worktrees'].includes(entry.name)) continue;
      yield* sources(rel);
    } else if (/\.(ts|json)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) yield rel;
  }
}

function controlPlaneFiles(): string[] {
  return [
    ...sources('packages'),
    ...sources('apps/api'),
    ...sources('apps/worker'),
    ...sources('apps/mcp-server'),
    ...sources('apps/dashboard'),
  ];
}

describe('a withheld localRef cannot be dereferenced from the control plane (003 T021, R-08)', () => {
  it('no control-plane source imports the runner or its ledger', () => {
    const offenders = controlPlaneFiles().filter((file) => {
      const text = readFileSync(join(ROOT, file), 'utf8');
      return /withholding-ledger|FsWithholdingLedger|@healer\/runner/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('the control-plane database holds no ledger and no localRef column', () => {
    const schema = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8');
    expect(schema).not.toMatch(/withholding_?ledger/i); // (the reason code redaction_withheld is a closed-list value, not a ledger)
    expect(schema).not.toMatch(/local_?ref/i);
  });

  it('the HTTP surface has no route that resolves one', () => {
    const openapi = JSON.parse(readFileSync(join(ROOT, 'apps/api/openapi.json'), 'utf8')) as {
      paths: Record<string, unknown>;
    };
    const resolvers = Object.keys(openapi.paths).filter((p) =>
      /local-?ref|withheld|resolve-?ref|ledger/i.test(p),
    );
    expect(resolvers).toEqual([]);
  });

  it('the domain entry surface exports nothing that could resolve a reference', () => {
    const resolvers = Object.keys(domainContext).filter((name) =>
      /resolve|dereference|ledger|localRef/i.test(name),
    );
    expect(resolvers).toEqual([]);
  });
});
