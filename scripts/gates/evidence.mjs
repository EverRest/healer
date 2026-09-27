#!/usr/bin/env node
// `gate-evidence` (012 T031, 001 FR-009, T010, FR-016a): every persisted conclusion must be
// registered against a real member of the closed `ConclusionType` list — the same list
// `evidence_link.conclusion_type` is drawn from. That list is the one authority (a closed list has
// exactly one authority, docs/patterns.md): this gate cannot see whether a given conclusion row
// actually has an `evidence_link` (that's a data question, not a schema question — checked at
// runtime by `assertHasEvidence`, packages/domain/evidence, and continuously in production by
// `check:evidence-coverage`, SC-002), but it can catch a conclusion table wired to a type that
// isn't in the list at all — the same class of drift a typo would otherwise ship silently.
//
// A model opts in with `/// @conclusion <type>` directly above it in schema.prisma, `<type>`
// naming one `ConclusionType` value. Originally (before 001 landed) this checked for a
// non-nullable `evidenceId` column directly on the conclusion model — that assumed a one-to-one FK
// that 001's actual design never uses: `evidence_link` is a many-to-many join keyed by
// `(conclusion_type, conclusion_id)`, not a column on the conclusion table itself.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';

const SCHEMA_PATH = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url));

/** @param {string} schemaSource */
function conclusionTypeValues(schemaSource) {
  const match = schemaSource.match(/enum\s+ConclusionType\s*\{([^}]*)\}/);
  if (!match) return [];
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('@@') && !line.startsWith('///'));
}

const CONCLUSION_TAG_PATTERN =
  /\/\/\/[ \t]*@conclusion([^\n]*)\n(?:[ \t]*\/\/\/[^\n]*\n)*[ \t]*model\s+(\w+)/g;

/**
 * The one authority for which models are tagged `@conclusion <type>` — `check:evidence-coverage`
 * (001 T033, SC-002) reads this same parse to know which tables to check for unlinked rows at
 * runtime, rather than a second, necessarily-divergent list.
 * @param {string} schemaSource
 */
export function parseConclusionTags(schemaSource) {
  const tags = [];
  for (const match of schemaSource.matchAll(CONCLUSION_TAG_PATTERN)) {
    const [, rest, model] = match;
    const type = rest.trim();
    if (type !== '') tags.push({ model, type });
  }
  return tags;
}

/** @param {string} schemaSource */
export function findConclusionTagsWithUnknownType(schemaSource) {
  const validTypes = conclusionTypeValues(schemaSource);
  const issues = [];
  for (const match of schemaSource.matchAll(CONCLUSION_TAG_PATTERN)) {
    const [, rest, name] = match;
    const taggedType = rest.trim();
    if (taggedType === '') {
      issues.push(`${name}: tagged @conclusion with no type — must name a ConclusionType value`);
      continue;
    }
    if (!validTypes.includes(taggedType)) {
      issues.push(
        `${name}: tagged @conclusion ${taggedType}, which is not a ConclusionType value ` +
          `(${validTypes.join(', ')})`,
      );
    }
  }
  return issues;
}

/* v8 ignore start -- CLI wiring; the check it calls is unit tested above */
if (isMainModule(import.meta.url)) {
  const result = await runGate('gate-evidence', () => {
    const issues = findConclusionTagsWithUnknownType(readFileSync(SCHEMA_PATH, 'utf8'));
    if (issues.length > 0) throw new Error(issues.join('; '));
  });
  reportAndExit(result);
}
/* v8 ignore stop */
