import {
  Prisma,
  type NormalisationRuleset as RulesetRow,
  type PrismaClient,
} from '@healer/prisma-client';
import type {
  NewNormalisationRuleset,
  NormalisationRuleset,
  NormalisationRulesetRepository,
} from '../domain/normalisation-ruleset.js';

function toDomain(row: RulesetRow): NormalisationRuleset {
  return {
    version: row.version,
    rules: row.rules,
    publishedAt: row.publishedAt,
    note: row.note,
  };
}

export class PrismaNormalisationRulesetRepository implements NormalisationRulesetRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getByVersion(version: number): Promise<NormalisationRuleset | null> {
    const row = await this.prisma.normalisationRuleset.findUnique({ where: { version } });
    return row === null ? null : toDomain(row);
  }

  async getLatest(): Promise<NormalisationRuleset | null> {
    const row = await this.prisma.normalisationRuleset.findFirst({
      orderBy: { version: 'desc' },
    });
    return row === null ? null : toDomain(row);
  }

  async publish(ruleset: NewNormalisationRuleset): Promise<NormalisationRuleset> {
    // ponytail: read-then-insert under READ COMMITTED can race two concurrent publishes onto the
    // same next version; the version column's PK is the actual safety net (one insert wins, the
    // other throws a unique-violation the caller sees and retries) — publishing a ruleset is a
    // rare, deliberate action, not a hot path, so that is the acceptable cost, not a lock.
    return this.prisma.$transaction(async (tx) => {
      const latest = await tx.normalisationRuleset.findFirst({ orderBy: { version: 'desc' } });
      const row = await tx.normalisationRuleset.create({
        data: {
          version: (latest?.version ?? 0) + 1,
          rules: ruleset.rules as Prisma.InputJsonValue,
          note: ruleset.note ?? null,
        },
      });
      return toDomain(row);
    });
  }
}
