#!/usr/bin/env node
// `check:no-payload-at-rest` (003 T031, R-13): no `boundary_rejection` row carries payload content.
// The table is allowed exactly the columns below — none can hold a body — a digest must be a
// sha256 hex string, and every schema-error path must be structural text (identifiers, indexes,
// `#code`), which prose is not. The data question the schema alone cannot answer: a column is not
// a payload today, but a hand-written row, or a future writer, could still put one in a text[].
// Violations name the row, never its content.
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';

export const ALLOWED_COLUMNS = [
  'id',
  'tenant_id',
  'runner_id',
  'pass_id',
  'contract_version',
  'schema_error_paths',
  'payload_digest',
  'byte_size',
  'received_at',
];

/** Same pattern in JS and (as a parameter) in SQL, so there is one definition of "structural". */
export const PATH_PATTERN = /^[A-Za-z0-9_.<>$#-]{1,200}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** @param {string[]} columns */
export function findColumnViolations(columns) {
  const extra = columns.filter((c) => !ALLOWED_COLUMNS.includes(c)).sort();
  const missing = ALLOWED_COLUMNS.filter((c) => !columns.includes(c));
  return [
    ...extra.map((c) => `boundary_rejection has a column outside the allowed list: ${c}`),
    ...missing.map((c) => `boundary_rejection is missing the expected column: ${c}`),
  ];
}

/** @param {{ id: string, payload_digest: string, schema_error_paths: string[] }[]} rows */
export function findRowViolations(rows) {
  const violations = [];
  for (const row of rows) {
    if (!DIGEST_PATTERN.test(row.payload_digest)) {
      violations.push(
        `boundary_rejection ${row.id}: payload_digest is not 64 lowercase hex characters`,
      );
    }
    row.schema_error_paths.forEach((path, i) => {
      if (!PATH_PATTERN.test(path)) {
        violations.push(
          `boundary_rejection ${row.id}: schema_error_paths[${i}] is not a structural path`,
        );
      }
    });
  }
  return violations;
}

/**
 * The live queries, isolated so an e2e test drives them against a real Postgres. Row filtering
 * happens in SQL so only offenders (ids, never contents) are ever read back.
 * @param {import('../../prisma/generated/client/index.js').PrismaClient} prisma
 */
export async function findLiveViolations(prisma) {
  const columns = await prisma.$queryRaw`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'context' AND table_name = 'boundary_rejection'`;
  const offenders = await prisma.$queryRaw`
    SELECT id::text AS id, payload_digest,
           ARRAY(SELECT p FROM unnest(schema_error_paths) p WHERE p !~ ${PATH_PATTERN.source}) AS bad
    FROM "context"."boundary_rejection"
    WHERE payload_digest !~ '^[0-9a-f]{64}$'
       OR EXISTS (SELECT 1 FROM unnest(schema_error_paths) p WHERE p !~ ${PATH_PATTERN.source})`;
  return [
    ...findColumnViolations(columns.map((c) => c.column_name)),
    // `bad` stays inside this function; findRowViolations sees the offending paths only to
    // classify them, and its messages never repeat them.
    ...findRowViolations(
      offenders.map((o) => ({
        id: o.id,
        payload_digest: o.payload_digest,
        schema_error_paths: o.bad,
      })),
    ),
  ];
}

/* v8 ignore start -- CLI wiring; the queries it drives are proven by no-payload-at-rest.e2e.test.ts */
if (isMainModule(import.meta.url)) {
  const result = await runGate('check:no-payload-at-rest', async () => {
    const prisma = new PrismaClient();
    try {
      const violations = await findLiveViolations(prisma);
      if (violations.length > 0) throw new Error(violations.join('; '));
      process.stderr.write(
        'check:no-payload-at-rest: no boundary_rejection row carries payload content\n',
      );
    } finally {
      await prisma.$disconnect();
    }
  });
  reportAndExit(result);
}
/* v8 ignore stop */
