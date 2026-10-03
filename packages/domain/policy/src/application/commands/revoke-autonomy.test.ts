import { describe, expect, it } from 'vitest';
import { NotFoundError, TenantContext, type TenantScoped } from '@healer/shared';
import {
  GrantAlreadyRevokedError,
  type AutonomyGrant,
  type AutonomyGrantRepository,
  type NewAutonomyGrant,
  type RevokeAutonomyGrant,
} from '../../domain/autonomy-grant-repository.js';
import { revokeAutonomy } from './revoke-autonomy.js';

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000e2');

class FakeGrantRepo implements AutonomyGrantRepository {
  revoked: TenantScoped<RevokeAutonomyGrant>[] = [];
  constructor(private readonly existing: AutonomyGrant | null) {}
  async findActive(): Promise<readonly AutonomyGrant[]> {
    return [];
  }
  async findById(): Promise<AutonomyGrant | null> {
    return this.existing;
  }
  async list(): Promise<readonly AutonomyGrant[]> {
    return [];
  }
  async create(_where: TenantScoped<NewAutonomyGrant>): Promise<AutonomyGrant> {
    throw new Error('not used by this test');
  }
  async revoke(where: TenantScoped<RevokeAutonomyGrant>): Promise<AutonomyGrant> {
    this.revoked.push(where);
    if (this.existing === null) throw new NotFoundError('autonomy_grant');
    if (this.existing.revokedAt !== undefined) throw new GrantAlreadyRevokedError(where.id);
    return { ...this.existing, revokedBy: where.revokedBy, revokedAt: where.revokedAt };
  }
}

const ACTIVE_GRANT: AutonomyGrant = {
  id: 'grant-1',
  actionKey: 'change.open_pull_request',
  level: 2,
  grantedBy: 'pavlo',
  grantedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('revokeAutonomy (T039, T043)', () => {
  it('revokes an active grant', async () => {
    const grants = new FakeGrantRepo(ACTIVE_GRANT);
    const revoked = await revokeAutonomy(
      { grants },
      CONTEXT,
      { grantId: 'grant-1', revokedBy: 'pavlo' },
      () => new Date('2026-01-02T00:00:00Z'),
    );
    expect(revoked.revokedAt).toEqual(new Date('2026-01-02T00:00:00Z'));
    expect(grants.revoked[0]).toMatchObject({ id: 'grant-1', revokedBy: 'pavlo' });
  });

  it('records a bump reason on the epoch, defaulting from the revoking actor', async () => {
    const grants = new FakeGrantRepo(ACTIVE_GRANT);
    await revokeAutonomy({ grants }, CONTEXT, { grantId: 'grant-1', revokedBy: 'pavlo' });
    expect(grants.revoked[0]?.bumpReason).toContain('pavlo');
  });

  it('refuses an unknown grant id', async () => {
    await expect(
      revokeAutonomy({ grants: new FakeGrantRepo(null) }, CONTEXT, {
        grantId: 'does-not-exist',
        revokedBy: 'pavlo',
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('refuses a grant already revoked (data-model.md: terminal, never reactivated)', async () => {
    const alreadyRevoked: AutonomyGrant = {
      ...ACTIVE_GRANT,
      revokedBy: 'someone-else',
      revokedAt: new Date('2026-01-01T12:00:00Z'),
    };
    await expect(
      revokeAutonomy({ grants: new FakeGrantRepo(alreadyRevoked) }, CONTEXT, {
        grantId: 'grant-1',
        revokedBy: 'pavlo',
      }),
    ).rejects.toThrow(GrantAlreadyRevokedError);
  });
});
