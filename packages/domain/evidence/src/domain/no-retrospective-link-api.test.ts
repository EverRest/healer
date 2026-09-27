import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 001 T036 (R-06, quickstart 11): "no retrospective links" is a design assertion, not a runtime
 * guarantee to test against fixtures — quickstart 11 itself says so ("tested by contract
 * review"). `AttachLink` (001 T028) is only ever called in-process by the step that produced the
 * evidence; nothing wraps it in a controller, so there is no HTTP surface through which a caller
 * could create a link independently of the step actually executing, whether for a past step or
 * for another one. Checked against `apps/api/openapi.json` — the generated, `contracts-check`-
 * enforced document reflecting what is actually built, not the aspirational full-feature spec
 * contract under `specs/`, which names routes many tasks ahead of where this feature currently
 * is and would need no re-verification here as those land.
 *
 * The other half of R-06 ("or for another step") is a runtime guarantee, already proven directly:
 * `evidence-link-repository.e2e.test.ts` (001 T007/T008) shows a link attributed to a step other
 * than the one executing is rejected, and `NewEvidenceLink` (link-repository.ts) has no
 * `assertedByStep` field for a caller to even attempt it — structurally, not by validation.
 */
const OPENAPI_PATH = fileURLToPath(
  new URL('../../../../../apps/api/openapi.json', import.meta.url),
);

describe('no API creates an evidence_link retrospectively (001 T036, R-06, quickstart 11)', () => {
  it('the committed, contracts-check-enforced document has no route that could attach or create a link', () => {
    const openapi = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as {
      paths?: Record<string, Record<string, unknown>>;
    };
    const routes = Object.entries(openapi.paths ?? {}).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
    );
    const linkRoutes = routes.filter((route) => /link/i.test(route));
    expect(linkRoutes).toEqual([]);
  });
});
