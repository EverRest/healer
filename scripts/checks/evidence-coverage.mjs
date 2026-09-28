#!/usr/bin/env node
// `check:evidence-coverage` (001 T033, SC-002): every persisted conclusion carries at least one
// resolvable evidence link. `gate-evidence` (012 T031, 001 T010) already checks that a conclusion
// table is wired to a real `ConclusionType` value — a schema question; this checks the data
// question it explicitly defers: does a given conclusion row actually have a link. Reads the
// same `@conclusion <type>` tag `gate-evidence` parses (one authority, not a second list), so a
// future spec's conclusion table is covered the moment it opts in, with no edit here.
//
// Today this checks zero tables: no 003+ spec has landed a conclusion table yet, so nothing is
// tagged. That is a correct, honest "nothing to check" — not a reason to skip building this now,
// since `assertHasEvidence` (the write-time guarantee this backs up, in case a row ever reaches
// the database some other way) already exists and needs this continuous counterpart per SC-002.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';
import { parseConclusionTags } from '../gates/evidence.mjs';

const SCHEMA_PATH = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url));

/**
 * A tagged model's real table: every model in this schema uses a bare `id String @id @db.Uuid`
 * primary key with no `@map` override (confirmed against every model in schema.prisma), so only
 * `@@map`/`@@schema` need resolving here.
 * @param {string} schemaSource
 * @param {string} modelName
 */
export function modelTable(schemaSource, modelName) {
  const body = schemaSource.match(
    new RegExp(`model\\s+${modelName}\\s*\\{([\\s\\S]*?)\\n\\}`),
  )?.[1];
  if (body === undefined) return null;
  const schema = body.match(/@@schema\("([^"]+)"\)/)?.[1];
  const table = body.match(/@@map\("([^"]+)"\)/)?.[1];
  if (schema === undefined || table === undefined) return null;
  return { schema, table };
}

/**
 * @param {import('../../prisma/generated/client/index.js').PrismaClient} prisma
 * @param {{ model: string, type: string, schema: string, table: string }[]} taggedTables
 */
export async function findUnlinkedConclusions(prisma, taggedTables) {
  const violations = [];
  for (const { type, schema, table } of taggedTables) {
    // Review finding: `el.tenant_id = c.tenant_id` is not redundant with the UUID join alone — a
    // link recorded under the wrong tenant naming a real conclusion id would otherwise still
    // count as coverage for that row, exactly the class of leak this repository's own rule
    // ("every query carries tenantId") exists to close.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM "${schema}"."${table}" c WHERE NOT EXISTS (
         SELECT 1 FROM "evidence"."evidence_link" el
         WHERE el.conclusion_type = $1::"evidence"."conclusion_type" AND el.conclusion_id = c.id
           AND el.tenant_id = c.tenant_id
       )`,
      type,
    );
    for (const row of rows)
      violations.push(`${schema}.${table} ${row.id} (${type}): no evidence_link`);
  }
  return violations;
}

/* v8 ignore start -- CLI wiring; the parsers above are unit tested, the query by an e2e test */
function taggedTables() {
  const schemaSource = readFileSync(SCHEMA_PATH, 'utf8');
  return parseConclusionTags(schemaSource).map((tag) => {
    const table = modelTable(schemaSource, tag.model);
    // Review finding: silently dropping an unresolvable tag from the checked set would make
    // SC-002 pass by omission — a `@conclusion` tag with a typo'd or missing `@@map`/`@@schema`
    // must fail this gate loudly, not disappear from "N conclusion table(s) checked" uncounted.
    if (table === null) {
      throw new Error(
        `${tag.model} is tagged @conclusion ${tag.type} but has no resolvable @@map/@@schema`,
      );
    }
    return { ...tag, ...table };
  });
}

if (isMainModule(import.meta.url)) {
  const result = await runGate('check:evidence-coverage', async () => {
    const tables = taggedTables();
    const prisma = new PrismaClient();
    try {
      const violations = await findUnlinkedConclusions(prisma, tables);
      if (violations.length > 0) throw new Error(violations.join('; '));
      process.stderr.write(
        `check:evidence-coverage: ${tables.length} conclusion table(s) checked, all linked\n`,
      );
    } finally {
      await prisma.$disconnect();
    }
  });
  reportAndExit(result);
}
/* v8 ignore stop */
