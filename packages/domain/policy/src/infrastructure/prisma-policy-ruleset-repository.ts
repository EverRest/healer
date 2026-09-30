import { randomUUID } from 'node:crypto';
import { currentCorrelationId, type TenantScoped } from '@healer/shared';
import { Prisma, type PrismaClient } from '@healer/prisma-client';
import { enqueue, PrismaOutboxTransaction } from '@healer/events';
import { policyRulesetPublishedEvent } from '../domain/events.js';
import type { ConflictWarning } from '../domain/conflict-warnings.js';
import type { RuleBody } from '../domain/policy-ruleset.js';
import {
  StaleRulesetVersionError,
  type NewPublishedRuleset,
  type PolicyRulesetRepository,
  type PublishedRuleset,
} from '../domain/policy-ruleset-repository.js';
import type { Outcome } from '../domain/outcome-lattice.js';
import type { ReasonCode } from '../domain/reason-code.js';
import type { PredicateConjunction } from '../domain/predicates/types.js';
import { recordAuditEntry } from './record-audit-entry.js';

/** `publish` publishes an event — a missing correlation scope is a caller error, the same rule
 *  `prisma-issue-merge.ts`'s `assertCorrelated` already enforces for this package's sibling
 *  domain, checked before the transaction opens rather than discovered after two writes. */
function assertCorrelated(): void {
  if (currentCorrelationId() === undefined) {
    throw new Error(
      'PublishRuleset publishes PolicyRulesetPublished: call it inside a correlated scope (withCorrelation)',
    );
  }
}

interface RulesetRow {
  readonly id: string;
  readonly version: number;
  readonly digest: string;
  readonly publishedAt: Date;
  readonly publishedBy: string;
  readonly supersedesVersion: number | null;
  readonly conflictWarnings: unknown;
  readonly rules: readonly {
    readonly ruleKey: string;
    readonly predicates: unknown;
    readonly outcome: string;
    readonly reasonCode: string;
    readonly note: string;
  }[];
}

function toDomain(row: RulesetRow): PublishedRuleset {
  return {
    id: row.id,
    version: row.version,
    digest: row.digest,
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy,
    ...(row.supersedesVersion !== null ? { supersedesVersion: row.supersedesVersion } : {}),
    conflictWarnings: row.conflictWarnings as readonly ConflictWarning[],
    rules: row.rules.map((r) => ({
      ruleKey: r.ruleKey,
      predicates: r.predicates as PredicateConjunction,
      outcome: r.outcome as Outcome,
      reasonCode: r.reasonCode as ReasonCode,
      note: r.note,
    })),
  };
}

const RULESET_INCLUDE = { rules: true } as const;

/**
 * True only for a P2002 on `policy_ruleset`'s own `(tenant_id, version)` or `(tenant_id, digest)`
 * unique index — never for a P2002 raised by anything else this transaction touches.
 *
 * Review finding: the original version treated *any* P2002 from this transaction as the version
 * race this method exists to resolve. But this transaction also inserts into `policy_rule`, whose
 * own `@@unique([rulesetId, ruleKey])` constraint rejects a request with two rules sharing a
 * `ruleKey` — a caller error `publishRuleset` now rejects before this method is ever called
 * (`assertUniqueRuleKeys`), but nothing here would have known that: the old code caught that
 * P2002 too, misdiagnosed it as `StaleRulesetVersionError`, and `publishRuleset`'s retry loop
 * burned every attempt against a request that could never succeed regardless of how many times
 * it re-read the tenant's state. Confirmed empirically (a throwaway probe against a real Postgres,
 * not from documentation) that Prisma's `error.meta` for a Postgres unique violation carries
 * `{ modelName, target }`, with `target` the raw snake_case column list — `["tenant_id",
 * "version"]` / `["tenant_id", "digest"]` for this table, `["ruleset_id", "rule_key"]` for
 * `policy_rule` — so checking `modelName` alone already disambiguates the two tables; the column
 * check on top is what pins it to *this table's own two* indexes specifically, not some future
 * third one added to `policy_ruleset` this method hasn't been taught about.
 */
function isRulesetVersionOrDigestConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const meta = error.meta as
    { readonly modelName?: unknown; readonly target?: unknown } | undefined;
  if (meta?.modelName !== 'PolicyRuleset') return false;
  const target = meta.target;
  if (!Array.isArray(target)) return false;
  return (
    (target.includes('tenant_id') && target.includes('version')) ||
    (target.includes('tenant_id') && target.includes('digest'))
  );
}

/**
 * `PolicyRulesetRepository` (T019, data-model.md `policy.policy_ruleset` / `policy.policy_rule`).
 * `publish` writes the ruleset, its rules and the audit entry naming both versions in one
 * transaction (data-model.md: "that entry *is* the diff", FR-020) using the shared
 * `recordAuditEntry` helper (T017) — the caller (`publishRuleset`) already built the
 * `TenantScoped<NewAuditEntry>` via `scope(context, ...)`, since it holds the real
 * `TenantContext` this method never does (review finding: forcing the helper's construction in
 * here, without a `TenantContext`, was the wrong layer for it) — and publishes
 * `PolicyRulesetPublished` through the same transaction's outbox.
 *
 * Concurrency (review finding): the version/digest this call attempts is a snapshot the caller
 * read before this transaction opened. If the insert fails on `policy_ruleset`'s own
 * `(tenant_id, version)` or `(tenant_id, digest)` unique index specifically
 * (`isRulesetVersionOrDigestConflict`) — never for any other constraint this transaction's insert
 * can violate — this re-checks by digest: if a row with this exact digest now exists, that *is*
 * R-01's no-op, resolved here rather than left as a raw `P2002` for the caller, no matter which of
 * two racing publishes of identical content actually landed. Otherwise the conflict was on
 * `version` — this tenant's next version was taken by different content between the caller's read
 * and this write — and `StaleRulesetVersionError` tells `publishRuleset`'s retry loop to
 * recompute against fresh state. Any other error, including a P2002 from `policy_rule`'s own
 * `@@unique([rulesetId, ruleKey])` constraint, propagates unchanged.
 */
export class PrismaPolicyRulesetRepository implements PolicyRulesetRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByDigest(where: TenantScoped<{ digest: string }>): Promise<PublishedRuleset | null> {
    const row = await this.prisma.policyRuleset.findUnique({
      where: { tenantId_digest: { tenantId: where.tenantId, digest: where.digest } },
      include: RULESET_INCLUDE,
    });
    return row === null ? null : toDomain(row);
  }

  async findLatest(where: TenantScoped<object>): Promise<PublishedRuleset | null> {
    const row = await this.prisma.policyRuleset.findFirst({
      where: { tenantId: where.tenantId },
      orderBy: { version: 'desc' },
      include: RULESET_INCLUDE,
    });
    return row === null ? null : toDomain(row);
  }

  async findByVersion(where: TenantScoped<{ version: number }>): Promise<PublishedRuleset | null> {
    const row = await this.prisma.policyRuleset.findUnique({
      where: { tenantId_version: { tenantId: where.tenantId, version: where.version } },
      include: RULESET_INCLUDE,
    });
    return row === null ? null : toDomain(row);
  }

  async list(where: TenantScoped<object>): Promise<readonly PublishedRuleset[]> {
    const rows = await this.prisma.policyRuleset.findMany({
      where: { tenantId: where.tenantId },
      orderBy: { version: 'desc' },
      include: RULESET_INCLUDE,
    });
    return rows.map(toDomain);
  }

  async publish(where: TenantScoped<NewPublishedRuleset>): Promise<PublishedRuleset> {
    assertCorrelated();
    const { tenantId } = where;
    const event = policyRulesetPublishedEvent(tenantId, {
      rulesetId: where.id,
      version: where.version,
      digest: where.digest,
      ...(where.supersedesVersion !== undefined
        ? { supersedesVersion: where.supersedesVersion }
        : {}),
    });

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.policyRuleset.create({
          data: {
            id: where.id,
            tenantId,
            version: where.version,
            digest: where.digest,
            publishedAt: where.publishedAt,
            publishedBy: where.publishedBy,
            supersedesVersion: where.supersedesVersion ?? null,
            conflictWarnings: where.conflictWarnings as unknown as Prisma.InputJsonValue,
            rules: { createMany: { data: where.rules.map((r: RuleBody) => ruleRow(r)) } },
          },
          include: RULESET_INCLUDE,
        });

        await recordAuditEntry(tx, where.auditEntry);
        await enqueue(new PrismaOutboxTransaction(tx), event);
        return created;
      });

      return toDomain(row);
    } catch (error) {
      if (!isRulesetVersionOrDigestConflict(error)) throw error;

      // The failed transaction rolled back everything, including the audit entry and outbox
      // write — this re-check runs outside it, against whatever a concurrent publish actually
      // committed. `where` already carries `digest` and a proven `tenantId` (structurally a
      // `TenantScoped<{ digest: string }>`, no cast needed).
      const existing = await this.findByDigest(where);
      if (existing !== null) return existing;
      throw new StaleRulesetVersionError(tenantId, where.version);
    }
  }
}

function ruleRow(rule: RuleBody): {
  id: string;
  ruleKey: string;
  predicates: Prisma.InputJsonValue;
  outcome: Outcome;
  reasonCode: ReasonCode;
  note: string;
} {
  return {
    id: randomUUID(),
    ruleKey: rule.ruleKey,
    predicates: rule.predicates as unknown as Prisma.InputJsonValue,
    outcome: rule.outcome,
    reasonCode: rule.reasonCode,
    note: rule.note,
  };
}
