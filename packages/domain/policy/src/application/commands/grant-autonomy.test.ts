import { describe, expect, it } from 'vitest';
import { TenantContext, type TenantScoped } from '@healer/shared';
import type { ActionClass } from '../../domain/action-class.js';
import type {
  AutonomyGrant,
  AutonomyGrantRepository,
  NewAutonomyGrant,
  RevokeAutonomyGrant,
} from '../../domain/autonomy-grant-repository.js';
import type {
  PolicyAction,
  PolicyActionRepository,
} from '../../domain/policy-action-repository.js';
import { UnregisteredActionError } from '../resolve-ruleset-and-evaluate.js';
import { CeilingExceededError } from '../../domain/autonomy-grant-repository.js';
import { grantAutonomy } from './grant-autonomy.js';

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000e1');

class FakeActionRepo implements PolicyActionRepository {
  constructor(
    private readonly byKey: ReadonlyMap<string, ActionClass> = new Map([
      ['change.open_pull_request', 'code_change'],
      ['deployment.rollback', 'reversible_remediation'],
    ]),
  ) {}
  async findByKey(actionKey: string): Promise<PolicyAction | null> {
    const actionClass = this.byKey.get(actionKey);
    if (actionClass === undefined) return null;
    return { actionKey, actionClass, mutating: true, owningSpec: 'test', introducedAt: new Date() };
  }
  async list(): Promise<readonly PolicyAction[]> {
    return [];
  }
}

class FakeGrantRepo implements AutonomyGrantRepository {
  created: TenantScoped<NewAutonomyGrant>[] = [];
  async findActive(): Promise<readonly AutonomyGrant[]> {
    return [];
  }
  async findById(): Promise<AutonomyGrant | null> {
    return null;
  }
  async list(): Promise<readonly AutonomyGrant[]> {
    return [];
  }
  async create(where: TenantScoped<NewAutonomyGrant>): Promise<AutonomyGrant> {
    this.created.push(where);
    return {
      id: where.id,
      ...(where.componentId !== undefined ? { componentId: where.componentId } : {}),
      ...(where.environment !== undefined ? { environment: where.environment } : {}),
      ...(where.issueKind !== undefined ? { issueKind: where.issueKind } : {}),
      actionKey: where.actionKey,
      level: where.level,
      grantedBy: where.grantedBy,
      grantedAt: where.grantedAt,
    };
  }
  async revoke(_where: TenantScoped<RevokeAutonomyGrant>): Promise<AutonomyGrant> {
    throw new Error('not used by this test');
  }
}

describe('grantAutonomy (T034, T037, T039)', () => {
  it('grants a level at or under the ceiling', async () => {
    const grants = new FakeGrantRepo();
    const grant = await grantAutonomy(
      { grants, actions: new FakeActionRepo() },
      CONTEXT,
      { actionKey: 'change.open_pull_request', level: 2, grantedBy: 'pavlo' },
      () => new Date('2026-01-01T00:00:00Z'),
    );
    expect(grant.level).toBe(2);
    expect(grants.created).toHaveLength(1);
  });

  // Quickstart 7: grant L3 for change.open_pull_request (class code_change, ceiling L2) → 422
  // CEILING_EXCEEDED.
  it('refuses a level above the action class ceiling', async () => {
    await expect(
      grantAutonomy({ grants: new FakeGrantRepo(), actions: new FakeActionRepo() }, CONTEXT, {
        actionKey: 'change.open_pull_request',
        level: 3,
        grantedBy: 'pavlo',
      }),
    ).rejects.toThrow(CeilingExceededError);
  });

  it('CeilingExceededError is a HealerError with code CEILING_EXCEEDED', async () => {
    await expect(
      grantAutonomy({ grants: new FakeGrantRepo(), actions: new FakeActionRepo() }, CONTEXT, {
        actionKey: 'change.open_pull_request',
        level: 3,
        grantedBy: 'pavlo',
      }),
    ).rejects.toMatchObject({ code: 'CEILING_EXCEEDED' });
  });

  // Quickstart 39 / C-18: reversible_remediation has no level at all while the undo is
  // unattested — and no attestation source exists in this repository yet (010 not built), so
  // every reversible_remediation grant is refused today, at any level including 0.
  it('refuses any level for a reversible_remediation action while no undo attestation source exists', async () => {
    await expect(
      grantAutonomy({ grants: new FakeGrantRepo(), actions: new FakeActionRepo() }, CONTEXT, {
        actionKey: 'deployment.rollback',
        level: 0,
        grantedBy: 'pavlo',
      }),
    ).rejects.toThrow(CeilingExceededError);
  });

  it('refuses an unregistered action key', async () => {
    await expect(
      grantAutonomy(
        { grants: new FakeGrantRepo(), actions: new FakeActionRepo(new Map()) },
        CONTEXT,
        { actionKey: 'nobody.registered.this', level: 0, grantedBy: 'pavlo' },
      ),
    ).rejects.toThrow(UnregisteredActionError);
  });

  it('persists the scope fields when given, and omits them when not (data-model.md null = wildcard)', async () => {
    const grants = new FakeGrantRepo();
    await grantAutonomy(
      { grants, actions: new FakeActionRepo() },
      CONTEXT,
      {
        actionKey: 'change.open_pull_request',
        level: 1,
        grantedBy: 'pavlo',
        componentId: 'component-a',
        environment: 'production',
        issueKind: 'production_incident',
      },
      () => new Date('2026-01-01T00:00:00Z'),
    );
    expect(grants.created[0]).toMatchObject({
      componentId: 'component-a',
      environment: 'production',
      issueKind: 'production_incident',
    });

    await grantAutonomy(
      { grants, actions: new FakeActionRepo() },
      CONTEXT,
      { actionKey: 'change.open_pull_request', level: 1, grantedBy: 'pavlo' },
      () => new Date('2026-01-01T00:00:00Z'),
    );
    expect(grants.created[1]?.componentId).toBeUndefined();
    expect(grants.created[1]?.environment).toBeUndefined();
    expect(grants.created[1]?.issueKind).toBeUndefined();
  });
});
