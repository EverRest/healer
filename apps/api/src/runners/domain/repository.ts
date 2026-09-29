import type { TenantScoped } from '@healer/shared';
import type { HandshakeStatus, RunnerRegistrationSnapshot } from '@healer/boundary-contract';

/**
 * What registration and every heartbeat write (012 T042, FR-018, FR-020). `status` is the
 * handshake's own outcome (`resolveHandshake`, `@healer/boundary-contract`) — never computed a
 * second time here — and `revoked` is deliberately absent: no path in this feature sets it.
 */
export interface UpsertRunnerRegistration {
  readonly name: string;
  readonly protocolVersion: number;
  readonly capabilities: readonly string[];
  readonly imageVersion: string;
  readonly status: HandshakeStatus;
  readonly refusedReason?: string;
  readonly lastHeartbeatAt: Date;
}

/**
 * `runner_registration`, keyed by `(tenantId, name)` (data-model.md). `upsert` is the only
 * mutation: registration and every later heartbeat call it identically, so a heartbeat delivered
 * twice updates the same row rather than creating a second registration for the same runner
 * instance — the upsert itself is what makes a repeat delivery idempotent (FR-020's own
 * requirement), with no separate "is this a register or a heartbeat" branch to get wrong.
 *
 * Lives beside its only caller (`apps/api/src/runners`), not in a shared package: FR-001's closed
 * package list has no domain package for the runner's own control-plane state, and no second
 * caller exists yet (see QUESTIONS.md "012 phase 6, T042" for the full reasoning — promote this to
 * a shared package, the same way `packages/domain/issues` is shared with `apps/worker`, if and
 * when a scheduled stale-runner sweep needs it there too).
 */
export interface RunnerRegistrationRepository {
  upsert(input: TenantScoped<UpsertRunnerRegistration>): Promise<RunnerRegistrationSnapshot>;
  /** Read-back for the tenant-isolation test and any future lookup by name. */
  findByName(
    where: TenantScoped<{ readonly name: string }>,
  ): Promise<RunnerRegistrationSnapshot | null>;
}
