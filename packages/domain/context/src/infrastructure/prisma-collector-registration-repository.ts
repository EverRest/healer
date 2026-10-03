import type { PrismaClient } from '@healer/prisma-client';
import type { CollectorRegistrationRepository } from '../domain/collector-registration-repository.js';
import {
  describeParameterSchema,
  type CollectorDeclaration,
} from '../domain/collector-registry.js';

/**
 * Keeps `context.collector_registration` equal to the in-code `COLLECTOR_REGISTRY` (003 T013,
 * R-12). The code is the authority; the table is the queryable copy a follow-up request is
 * validated against. `introduced_at` is set on first insert and never touched again.
 */
export class PrismaCollectorRegistrationRepository implements CollectorRegistrationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async syncCollectorRegistry(registry: readonly CollectorDeclaration[]): Promise<void> {
    await this.prisma.$transaction(
      registry.map((d) => {
        const fields = {
          itemClasses: [...d.itemClasses],
          parameterSchema: describeParameterSchema(d.parameterSchema),
          defaultTimeoutMs: d.defaultTimeoutMs,
          requiredCapability: d.requiredCapability,
        };
        return this.prisma.collectorRegistration.upsert({
          where: { collectorKey: d.key },
          create: { collectorKey: d.key, ...fields },
          update: fields,
        });
      }),
    );
  }
}
