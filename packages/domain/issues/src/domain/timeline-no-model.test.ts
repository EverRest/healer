import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Quickstart 15 (R-07, C-14): the timeline is a query, with no model anywhere in its path. The
 * union itself is proven in `timeline.e2e.test.ts`; this is the "no model call" half, checked the
 * way quickstart 11 is — by what the code can reach, not by fixtures. `GET /issues/{id}/timeline`
 * is `IssuesController` -> `PrismaTimelineRepository`: if neither the controller nor this
 * package's workspace dependency closure contains a model package, no call can be made.
 */
const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const MODEL_PACKAGES = ['@healer/llm', '@healer/agents', '@healer/prompts'];

function workspacePackages(): Map<string, Record<string, string>> {
  const found = new Map<string, Record<string, string>>();
  const scan = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      const pkgPath = join(dir, entry.name, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          name: string;
          dependencies?: Record<string, string>;
        };
        found.set(pkg.name, pkg.dependencies ?? {});
      } else {
        scan(join(dir, entry.name));
      }
    }
  };
  scan(join(ROOT, 'packages'));
  return found;
}

describe('the timeline path has no model in it (001 T046, R-07, C-14, quickstart 15)', () => {
  it('no model package is in @healer/domain-issues’ workspace dependency closure', () => {
    const packages = workspacePackages();
    expect([...packages.keys()]).toEqual(expect.arrayContaining(MODEL_PACKAGES));
    const closure = new Set<string>();
    const visit = (name: string): void => {
      if (closure.has(name)) return;
      closure.add(name);
      for (const dep of Object.keys(packages.get(name) ?? {})) {
        if (packages.has(dep)) visit(dep);
      }
    };
    visit('@healer/domain-issues');
    expect(closure.has('@healer/shared')).toBe(true); // the walk reaches real dependencies
    expect(MODEL_PACKAGES.filter((name) => closure.has(name))).toEqual([]);
  });

  it('the controller serving the timeline imports no model package', () => {
    const controller = readFileSync(join(ROOT, 'apps/api/src/issues/issues.controller.ts'), 'utf8');
    expect(controller).toMatch(/timeline/i);
    expect(MODEL_PACKAGES.filter((name) => controller.includes(`'${name}`))).toEqual([]);
  });
});
