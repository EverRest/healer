#!/usr/bin/env node
// `contracts-check` (012 T033, FR-009, FR-012): the generated OpenAPI document must match the
// committed artifact byte for byte. Runs after `build` in the `ci` composition, since it
// imports compiled output rather than re-invoking the TypeScript compiler itself.
//
// FR-009 also names generated API clients and event schemas as artifacts this check must cover.
// No client generator or event-schema exporter has been chosen yet — that is a new-pattern
// decision (ADR territory), not something to invent silently here. Recorded in QUESTIONS.md.
import { readFileSync, existsSync } from 'node:fs';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';
import { OPENAPI_PATH, renderOpenApiDocument } from '../generate-openapi.mjs';

if (isMainModule(import.meta.url)) {
  const result = await runGate('contracts-check', async () => {
    const fresh = await renderOpenApiDocument();
    if (!existsSync(OPENAPI_PATH)) {
      throw new Error(`${OPENAPI_PATH} does not exist — run \`pnpm run generate:openapi\``);
    }
    const committed = readFileSync(OPENAPI_PATH, 'utf8');
    if (fresh !== committed) {
      throw new Error(
        `${OPENAPI_PATH} does not match the code it was generated from — run \`pnpm run generate:openapi\` and commit the result`,
      );
    }
  });
  reportAndExit(result);
}
