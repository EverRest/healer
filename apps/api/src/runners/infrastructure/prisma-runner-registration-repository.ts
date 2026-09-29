import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, type RunnerRegistration } from '@healer/prisma-client';
import { NotFoundError, createLogger, type TenantScoped } from '@healer/shared';
import type { RunnerRegistrationSnapshot } from '@healer/boundary-contract';
import type {
  RunnerRegistrationRepository,
  UpsertRunnerRegistration,
} from '../domain/repository.js';

// No config dependency (no `level`/`serviceName`) — safe to construct at module load, the same
// way `bootstrap()` constructs its own logger, but without needing `loadConfig()` first (this
// file is imported by contract generation and unit-test wiring that must not require
// `DATABASE_URL` or any other environment variable).
const logger = createLogger();

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
    const data = {
      protocolVersion: input.protocolVersion,
      capabilities: [...input.capabilities],
      imageVersion: input.imageVersion,
      status: input.status,
      lastHeartbeatAt: input.lastHeartbeatAt,
      refusedReason: input.refusedReason ?? null,
    };

    try {
      // A conditional `updateMany`, not a plain `upsert` (review finding): `revoked` is an admin
      // decision, never a handshake outcome, and a heartbeat must never undo it — `status: { not:
      // 'revoked' }` is what makes that true at the query itself, not a check a caller could
      // forget. `count > 0` means a live row existed and was updated; `count === 0` is ambiguous
      // between "no row yet" and "the row is revoked", resolved below.
      const { count } = await this.prisma.runnerRegistration.updateMany({
        where: { tenantId: input.tenantId, name: input.name, status: { not: 'revoked' } },
        data,
      });
      if (count > 0) return toDomain(await this.findExisting(input));

      const existing = await this.prisma.runnerRegistration.findUnique({
        where: { tenantId_name: { tenantId: input.tenantId, name: input.name } },
      });
      // Revoked — left exactly as it is, never re-created, never touched.
      if (existing !== null) return toDomain(existing);

      return toDomain(
        await this.prisma.runnerRegistration.create({
          data: { id: randomUUID(), tenantId: input.tenantId, name: input.name, ...data },
        }),
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        // `runner_registration` is the first tenant-scoped table with a real foreign key to
        // `tenant` — a syntactically valid but non-existent `tenantId` hits it here, and without
        // this catch it was an unhandled `PrismaClientKnownRequestError` (an opaque 500, with
        // *zero* logging — `apps/api` boots with `{logger: false}` and has no global exception
        // filter) rather than a clear, logged, translated error (review finding).
        if (error.code === 'P2003') {
          logger.warn(
            { tenantId: input.tenantId, name: input.name },
            'runner heartbeat referenced an unknown tenant',
          );
          throw new NotFoundError('tenant');
        }
        // Two concurrent *first-ever* heartbeats for the same brand-new `(tenantId, name)` both
        // saw no row above and both raced to create one — the same "someone else already created
        // it" shape `FingerprintAlreadyOpenError` documents for issues (001 T026). A heartbeat is
        // delivered repeatedly and is fully idempotent, so the useful response is the row that
        // won the race, not an error a repeated heartbeat has no way to act on.
        if (error.code === 'P2002') return toDomain(await this.findExisting(input));
      }
      throw error;
    }
  }

  private async findExisting(where: {
    readonly tenantId: string;
    readonly name: string;
  }): Promise<RunnerRegistration> {
    const row = await this.prisma.runnerRegistration.findUnique({
      where: { tenantId_name: { tenantId: where.tenantId, name: where.name } },
    });
    /* v8 ignore next -- the row this method is called to re-read was just written, in the same
     * transaction-free sequence, by the caller's own preceding write; its absence here would be a
     * concurrent delete this feature has no path for, not a case this repository's own callers
     * can provoke. */
    if (row === null) throw new NotFoundError('runner_registration');
    return row;
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
