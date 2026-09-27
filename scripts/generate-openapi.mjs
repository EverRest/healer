#!/usr/bin/env node
// Regenerates the committed OpenAPI document from code (012 FR-012). Run after `pnpm build` —
// it imports the compiled `apps/api/dist/openapi.js`, not the TypeScript source, the same
// artifact `contracts-check` diffs against.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import { isMainModule } from './lib/harness.mjs';

export const OPENAPI_PATH = fileURLToPath(new URL('../apps/api/openapi.json', import.meta.url));

// Formatted through Prettier, not just `JSON.stringify(doc, null, 2)`: otherwise the committed
// artifact and `format-check`'s opinion of it disagree forever, and every regeneration trips
// `format-check` even with zero real drift.
export async function renderOpenApiDocument() {
  const { buildOpenApiDocument } = await import('../apps/api/dist/openapi.js');
  const document = await buildOpenApiDocument();
  return prettier.format(JSON.stringify(document), { filepath: OPENAPI_PATH });
}

if (isMainModule(import.meta.url)) {
  writeFileSync(OPENAPI_PATH, await renderOpenApiDocument());
  process.stdout.write(`generate-openapi: wrote ${OPENAPI_PATH}\n`);
}
