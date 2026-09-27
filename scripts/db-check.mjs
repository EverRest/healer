#!/usr/bin/env node
// `db-check` (012 T021, T075, FR-009, FR-010, FR-048, FR-049).
//
// Schema drift, migration applicability to a clean database, every migration's reverse, and
// the tenant_id + leading-index rule are exercised dynamically against a real disposable
// Postgres — one authority, `prisma/migration.e2e.test.ts` — not re-parsed here with a second,
// necessarily-divergent static SQL reader. This script owns what that test cannot: running
// `prisma generate`, and the static, no-database checks below.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule, runGate, reportAndExit } from './lib/harness.mjs';

const MIGRATIONS_DIR = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));
const ADR_DIR = fileURLToPath(new URL('../docs/adr/', import.meta.url));

// A migration whose up-script contains one of these needs a recorded approval regardless of
// whether it also ships a `down.sql` — the down-script can restore the *shape* dropped by
// `DROP COLUMN`/`DROP TABLE`, never the *data*, so "has a reverse" does not mean "lossless".
// `TRUNCATE` excludes `TRUNCATE ON` — a trigger's event list (`BEFORE TRUNCATE ON ...`), which
// *prevents* a truncate rather than performing one, is the opposite of destructive.
const DESTRUCTIVE_PATTERN = /\b(DROP\s+COLUMN|DROP\s+TABLE|TRUNCATE(?!\s+ON\b))\b/i;

// SQL's line comment is `--`, not JS's `//` — the shared `stripComments` (scripts/lib) is
// JS-oriented and would leave a `-- TRUNCATE bypasses...` prose comment intact, false-positiving
// this check on the comment text itself rather than on real DDL.
export function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
}

export function adrExists(adrNumber) {
  const padded = adrNumber.padStart(4, '0');
  try {
    return readdirSync(ADR_DIR).some((file) => file.startsWith(`${padded}-`));
  } catch {
    return false;
  }
}

/** A destructive migration needs a sibling approval naming an existing ADR and an owner (FR-049). */
export function validateIrreversibleApproval(content, deps = { adrExists }) {
  if (!content) return 'missing IRREVERSIBLE.md';
  const adrMatch = content.match(/ADR\s*(\d+)/i);
  if (!adrMatch) return 'IRREVERSIBLE.md does not cite an ADR';
  if (!deps.adrExists(adrMatch[1])) {
    return `IRREVERSIBLE.md cites ADR ${adrMatch[1]}, which does not exist`;
  }
  if (!/owner:\s*\S+/i.test(content)) return 'IRREVERSIBLE.md does not name an owner';
  return null;
}

/** @param {{ name: string, upSql: string, approvalContent?: string }[]} migrations */
export function findUnapprovedIrreversibleMigrations(migrations, deps = { adrExists }) {
  const issues = [];
  for (const { name, upSql, approvalContent } of migrations) {
    if (!DESTRUCTIVE_PATTERN.test(stripSqlComments(upSql))) continue;
    const problem = validateIrreversibleApproval(approvalContent, deps);
    if (problem) issues.push(`${name}: ${problem}`);
  }
  return issues;
}

/* v8 ignore start -- CLI wiring (real fs/process I/O); logic above is unit tested */
function migrationDescriptors() {
  if (!existsSync(MIGRATIONS_DIR)) {
    throw new Error(`migrations directory not found: ${MIGRATIONS_DIR}`);
  }
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(MIGRATIONS_DIR, entry.name);
      const approvalPath = join(dir, 'IRREVERSIBLE.md');
      return {
        name: entry.name,
        upSql: readFileSync(join(dir, 'migration.sql'), 'utf8'),
        approvalContent: existsSync(approvalPath) ? readFileSync(approvalPath, 'utf8') : undefined,
      };
    });
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result.stdout ?? '';
}

if (isMainModule(import.meta.url)) {
  const result = await runGate('db-check', () => {
    run('pnpm', ['exec', 'prisma', 'generate', '--schema', 'prisma/schema.prisma']);

    const unapproved = findUnapprovedIrreversibleMigrations(migrationDescriptors());
    if (unapproved.length > 0) {
      throw new Error(
        `irreversible migration without a recorded approval: ${unapproved.join(', ')}`,
      );
    }

    // Not caught: a git failure here (not a repository, git missing) cannot be told apart
    // from "no tags exist" by silently treating both as zero tags, so it is left to fail
    // the gate rather than pass it (R-10). Zero tags with git succeeding is a real, checked
    // answer — there is no previous release yet — not an unknown.
    const previousReleaseTags = execFileSync('git', ['tag', '-l', 'v*'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
    if (previousReleaseTags.length === 0) {
      process.stderr.write(
        'db-check: no previous release tag yet — nothing to verify against (FR-010)\n',
      );
    }
    // Applicability to a clean database, to the previous release's schema (when one is
    // tagged), and reversibility are all exercised dynamically, against a real disposable
    // Postgres, by prisma/migration.e2e.test.ts — the one place that owns it.
    run('pnpm', ['exec', 'vitest', 'run', '--project', 'e2e', 'prisma/migration.e2e.test.ts']);
  });
  reportAndExit(result);
}
/* v8 ignore stop */
