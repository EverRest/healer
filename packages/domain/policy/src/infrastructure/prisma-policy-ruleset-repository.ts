import { randomUUID } from 'node:crypto';
import { currentCorrelationId, type TenantScoped } from '@healer/shared';
import { Prisma, type PrismaClient } from '@healer/prisma-client';
import { enqueue, PrismaOutboxTransaction } from '@healer/events';
import { policyRulesetPublishedEvent } from '../domain/events.js';
import type { ConflictWarning } from '../domain/conflict-warnings.js';
import type { RuleBody } from '../domain/policy-ruleset.js';
import type {
  NewPublishedRuleset,
  PolicyRulesetRepository,
  PublishedRuleset,
} from '../domain/policy-ruleset-repository.js';
import type { Outcome } from '../domain/outcome-lattice.js';
import type { ReasonCode } from '../domain/reason-code.js';
import type { PredicateConjunction } from '../domain/predicates/types.js';

/** `publish` publishes an event — a missing correlation scope is a caller error, the same rule
 *  `prisma-issue-merge.ts`'s `assertCorrelated` already enforces for this package's sibling
 *  domain, checked before the transaction opens rather than discovered after two writes. */
function assertCorrelated(): void {
  if (currentCorrelationId() === undefined) {
    throw new Error('PublishRuleset publishes PolicyRulesetPublished: call it inside a correlated scope (withCorrelation)');
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
 * `PolicyRulesetRepository` (T019, data-model.md `policy.policy_ruleset` / `policy.policy_rule`).
 * `publish` writes the ruleset, its rules and the audit entry naming both versions in one
 * transaction (data-model.md: "that entry *is* the diff", FR-020) using the shared
 * `recordAuditEntry` helper T017 built for exactly this — and publishes `PolicyRulesetPublished`
 * through the same transaction's outbox, the established convention
 * `prisma-issue-merge.ts`/`prisma-issue-repository.ts` already follow.
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

  async publish(where: TenantScoped<NewPublishedRuleset>): Promise<PublishedRuleset> {
    assertCorrelated();
    const { tenantId } = where;
    const event = policyRulesetPublishedEvent(tenantId, {
      rulesetId: where.id,
      version: where.version,
      digest: where.digest,
      ...(where.supersedesVersion !== undefined ? { supersedesVersion: where.supersedesVersion } : {}),
    });

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

      // `recordAuditEntry` (T017) takes `TenantScoped<NewAuditEntry>`, and that brand is only
      // producible by `scope(context, ...)` from a `TenantContext` — which this method, typed to
      // take a `TenantScoped` filter rather than a `TenantContext` (T015's pattern for every
      // *read* filter), never holds. Forcing it would mean either accepting a `TenantContext`
      // here (a different shape from every other method in this file) or reconstructing one via
      // `TenantContext.forTrustedInternalUse` — a constructor named specifically to flag
      // test/seed-only use, not something to call from production infrastructure. Writing the row
      // directly with the already-proven `tenantId` string is exactly what
      // `prisma-issue-merge.ts` and `prisma-transition-effects.ts` already do for their own
      // audit-shaped writes, so this follows that precedent rather than forcing T017's helper.
      await tx.auditEntry.create({
        data: {
          id: randomUUID(),
          tenantId,
          actorType: 'human',
          actorRef: where.publishedBy,
          action: 'policy.publish_ruleset',
          targetType: 'policy_ruleset',
          targetId: where.id,
          reason:
            where.supersedesVersion !== undefined
              ? `published version ${where.version}, superseding version ${where.supersedesVersion}`
              : `published version ${where.version}`,
          evidenceIds: [],
          outcome: 'ok',
        },
      });

      await enqueue(new PrismaOutboxTransaction(tx), event);
      return created;
    });

    return toDomain(row);
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
