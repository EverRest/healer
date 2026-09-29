import { randomUUID } from 'node:crypto';
import type { PrismaClient, RunnerRegistration } from '@healer/prisma-client';
import type { TenantScoped } from '@healer/shared';
import type { RunnerRegistrationSnapshot } from '@healer/boundary-contract';
import type {
  RunnerRegistrationRepository,
  UpsertRunnerRegistration,
} from '../domain/repository.js';

function toDomain(row: RunnerRegistration): RunnerRegistrationSnapshot {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    protocolVersion: row.protocolVersion,
    capabilities: row.capabilities,
    imageVersion: row.imageVersion,
    status: row.status,
    lastHeartbeatAt: row.lastHeartbeatAt,
    ...(row.refusedReason !== null ? { refusedReason: row.refusedReason } : {}),
  };
}

/** See `RunnerRegistrationRepository`'s own doc comment for why this lives here rather than in a
 *  shared package. */
export class PrismaRunnerRegistrationRepository implements RunnerRegistrationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(input: TenantScoped<UpsertRunnerRegistration>): Promise<RunnerRegistrationSnapshot> {
    const row = await this.prisma.runnerRegistration.upsert({
      where: { tenantId_name: { tenantId: input.tenantId, name: input.name } },
      create: {
        id: randomUUID(),
        tenantId: input.tenantId,
        name: input.name,
        protocolVersion: input.protocolVersion,
        capabilities: [...input.capabilities],
        imageVersion: input.imageVersion,
        status: input.status,
        lastHeartbeatAt: input.lastHeartbeatAt,
        refusedReason: input.refusedReason ?? null,
      },
      update: {
        protocolVersion: input.protocolVersion,
        capabilities: [...input.capabilities],
        imageVersion: input.imageVersion,
        status: input.status,
        lastHeartbeatAt: input.lastHeartbeatAt,
        refusedReason: input.refusedReason ?? null,
      },
    });
    return toDomain(row);
  }

  async findByName(
    where: TenantScoped<{ readonly name: string }>,
  ): Promise<RunnerRegistrationSnapshot | null> {
    const row = await this.prisma.runnerRegistration.findUnique({
      where: { tenantId_name: { tenantId: where.tenantId, name: where.name } },
    });
    return row === null ? null : toDomain(row);
  }
}
