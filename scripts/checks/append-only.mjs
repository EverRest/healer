#!/usr/bin/env node
// `check:append-only` (001 T034, SC-003): continuously verifies that every append-only trigger
// this feature's migrations declare is still present and enabled in the live database — a data
// question `gate-evidence`/`db-check` cannot answer, since both are static, source-only checks.
//
// Exists because this exact class of drift already happened once, caught only by hand-review:
// `workflow.workflow_transition` was declared append-only in schema.prisma, but the migration
// that was supposed to add its trigger never did (see docs/changelog.md, T011-T018 deep review).
// A gate reading schema.prisma would not have caught it either — schema.prisma says nothing
// about triggers. The migration SQL is the one authority for which triggers should exist; this
// reads it, not a second, hand-maintained list, then confirms the live database still agrees.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));

// Matches every `CREATE TRIGGER <name> BEFORE UPDATE OR DELETE|TRUNCATE ON "<schema>"."<table>"`
// statement — deliberately not restricted to `reject_mutation_unless_privileged`/
// `reject_truncate_unless_privileged` by function name, since what matters here is which
// triggers exist, not which shared function backs them (`evidence`'s own `reject_evidence_mutation`
// enforces a narrower rule with a differently-named function, but is exactly as much an
// append-only trigger as the fully-immutable tables' triggers are).
const TRIGGER_PATTERN =
  /CREATE TRIGGER\s+(\w+)\s+BEFORE\s+(?:UPDATE OR DELETE|TRUNCATE)\s+ON\s+"(\w+)"\."(\w+)"/g;

/** @param {string} sql */
export function declaredAppendOnlyTriggers(sql) {
  const triggers = [];
  for (const match of sql.matchAll(TRIGGER_PATTERN)) {
    const [, name, schema, table] = match;
    if (name.endsWith('_append_only') || name.endsWith('_no_truncate')) {
      triggers.push({ name, schema, table });
    }
  }
  return triggers;
}

/** @param {{ name: string, tgenabled: string }[]} liveTriggers */
export function findMissingOrDisabledTriggers(declared, liveTriggers) {
  const live = new Map(liveTriggers.map((t) => [t.name, t.tgenabled]));
  return declared
    .filter((t) => live.get(t.name) !== 'O') // Postgres: 'O' = enabled (origin), undefined = absent
    .map((t) => `${t.schema}.${t.table}: trigger ${t.name} is missing or disabled`);
}

/** Real fs walk — exported so both the CLI entry point and the e2e proof share one reader. */
export function allDeclaredTriggers() {
  const byName = new Map();
  for (const name of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()) {
    const sql = readFileSync(`${MIGRATIONS_DIR}${name}/migration.sql`, 'utf8');
    for (const trigger of declaredAppendOnlyTriggers(sql)) byName.set(trigger.name, trigger);
  }
  return [...byName.values()];
}

/**
 * The one live-database query, isolated so an e2e test can drive it against a real disposable
 * Postgres (with a deliberately disabled trigger) rather than trusting this untested against the
 * one thing it exists to check.
 * @param {import('../../prisma/generated/client/index.js').PrismaClient} prisma
 */
export async function findLiveViolations(prisma, declared = allDeclaredTriggers()) {
  const liveTriggers = await prisma.$queryRaw`SELECT tgname AS name, tgenabled FROM pg_trigger`;
  return findMissingOrDisabledTriggers(declared, liveTriggers);
}

/* v8 ignore start -- CLI wiring; the query it drives is proven by append-only.e2e.test.ts */
if (isMainModule(import.meta.url)) {
  const result = await runGate('check:append-only', async () => {
    const declared = allDeclaredTriggers();
    const prisma = new PrismaClient();
    try {
      const violations = await findLiveViolations(prisma, declared);
      if (violations.length > 0) throw new Error(violations.join('; '));
      process.stderr.write(
        `check:append-only: ${declared.length} append-only trigger(s) verified present and enabled\n`,
      );
    } finally {
      await prisma.$disconnect();
    }
  });
  reportAndExit(result);
}
/* v8 ignore stop */
