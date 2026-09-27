#!/usr/bin/env node
// `gate-evidence` (012 T031, 001 FR-009, FR-016a): no persisted conclusion type may have a
// nullable evidence reference. The rule belongs to 001 ("evidence or silence"); this gate only
// enforces it mechanically against the schema.
//
// A model opts in by a `/// @conclusion` doc comment directly above it in schema.prisma — no
// conclusion-type model exists yet (001 has not landed), so this is a real, working scanner with
// nothing to scan today, the same shape as every other Phase-4 gate waiting on a later spec.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';

const SCHEMA_PATH = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url));
const EVIDENCE_FIELD_PATTERN = /^\s*evidenceId\s+(\S+)/m;

/** @param {string} schemaSource */
export function findConclusionTypesWithNullableEvidence(schemaSource) {
  const issues = [];
  const modelPattern =
    /\/\/\/[ \t]*@conclusion[^\n]*\n(?:[ \t]*\/\/\/[^\n]*\n)*[ \t]*model\s+(\w+)\s*\{([^}]*)\}/g;
  for (const match of schemaSource.matchAll(modelPattern)) {
    const [, name, body] = match;
    const fieldMatch = EVIDENCE_FIELD_PATTERN.exec(body);
    if (!fieldMatch) {
      issues.push(`${name}: tagged @conclusion but declares no evidenceId field`);
      continue;
    }
    if (fieldMatch[1].endsWith('?')) {
      issues.push(`${name}: evidenceId is nullable (${fieldMatch[1]})`);
    }
  }
  return issues;
}

/* v8 ignore start -- CLI wiring; the check it calls is unit tested above */
if (isMainModule(import.meta.url)) {
  const result = await runGate('gate-evidence', () => {
    const issues = findConclusionTypesWithNullableEvidence(readFileSync(SCHEMA_PATH, 'utf8'));
    if (issues.length > 0) throw new Error(issues.join('; '));
  });
  reportAndExit(result);
}
/* v8 ignore stop */
