import { ServiceUnavailableException } from '@nestjs/common';

import { Permission } from './entities/permission.entity';
import { PolicyState } from './entities/policy-state.entity';
import { RoleGrant } from './entities/role-grant.entity';
import { UserRole } from './entities/user-role.entity';
import { PolicySnapshotService } from './policy-snapshot.service';

interface Policy {
  version: number;
  permissions: Pick<Permission, 'id' | 'name' | 'actions'>[];
  grants: Pick<
    RoleGrant,
    'roleId' | 'permissionId' | 'allActions' | 'actions'
  >[];
  userRoles: Pick<UserRole, 'userId' | 'roleId'>[];
}

/** users: read/update/delete; rbac: manage. */
const basePolicy = (): Policy => ({
  version: 1,
  permissions: [
    { id: 'p-users', name: 'users', actions: ['read', 'update', 'delete'] },
    { id: 'p-rbac', name: 'rbac', actions: ['manage'] },
  ],
  grants: [
    // reader: explicit read only
    {
      roleId: 'reader',
      permissionId: 'p-users',
      allActions: false,
      actions: ['read'],
    },
    // writer: explicit update only
    {
      roleId: 'writer',
      permissionId: 'p-users',
      allActions: false,
      actions: ['update'],
    },
    // admin: everything, including future actions
    { roleId: 'admin', permissionId: 'p-users', allActions: true, actions: [] },
    { roleId: 'admin', permissionId: 'p-rbac', allActions: true, actions: [] },
  ],
  userRoles: [
    { userId: 'alice', roleId: 'reader' },
    { userId: 'bob', roleId: 'reader' },
    { userId: 'bob', roleId: 'writer' },
    { userId: 'root', roleId: 'admin' },
  ],
});

function build(policy: Policy = basePolicy()) {
  const state = { policy, versionReadFails: false, loadFails: false };

  const manager = {
    findOneBy: jest.fn((entity: unknown) => {
      if (entity !== PolicyState) throw new Error('unexpected entity');
      if (state.versionReadFails) return Promise.reject(new Error('db down'));
      return Promise.resolve(
        state.policy ? { id: 1, version: state.policy.version } : null,
      );
    }),
    find: jest.fn((entity: unknown) => {
      if (state.loadFails) return Promise.reject(new Error('load failed'));
      if (entity === Permission)
        return Promise.resolve(state.policy.permissions);
      if (entity === RoleGrant) return Promise.resolve(state.policy.grants);
      return Promise.resolve(state.policy.userRoles);
    }),
  };
  const dataSource = {
    manager,
    transaction: jest.fn((_level: string, cb: (m: unknown) => unknown) =>
      cb(manager),
    ),
  };
  const service = new PolicySnapshotService(dataSource as never);
  return { service, state, manager, dataSource };
}

describe('PolicySnapshotService.authorize', () => {
  it('allows a user whose role grants the action', async () => {
    const { service } = build();
    await service.onModuleInit();

    await expect(service.authorize('alice', 'users', 'read')).resolves.toBe(
      true,
    );
  });

  it('denies an action the role does not grant', async () => {
    const { service } = build();
    await service.onModuleInit();

    await expect(service.authorize('alice', 'users', 'update')).resolves.toBe(
      false,
    );
  });

  it('unions the grants of several roles', async () => {
    const { service } = build();
    await service.onModuleInit();

    await expect(service.authorize('bob', 'users', 'read')).resolves.toBe(true);
    await expect(service.authorize('bob', 'users', 'update')).resolves.toBe(
      true,
    );
    await expect(service.authorize('bob', 'users', 'delete')).resolves.toBe(
      false,
    );
  });

  it('lets an all-actions grant cover every action of the permission', async () => {
    const { service } = build();
    await service.onModuleInit();

    for (const action of ['read', 'update', 'delete']) {
      await expect(service.authorize('root', 'users', action)).resolves.toBe(
        true,
      );
    }
    await expect(service.authorize('root', 'rbac', 'manage')).resolves.toBe(
      true,
    );
  });

  it('applies new actions to all-actions grants after a policy change', async () => {
    const { service, state } = build();
    await service.onModuleInit();
    await expect(service.authorize('root', 'users', 'list')).resolves.toBe(
      false,
    );

    state.policy.permissions[0].actions.push('list');
    state.policy.version = 2;

    await expect(service.authorize('root', 'users', 'list')).resolves.toBe(
      true,
    );
    // An explicit grant does not grow with the permission.
    await expect(service.authorize('alice', 'users', 'list')).resolves.toBe(
      false,
    );
  });

  it('denies a user without roles and an unknown user', async () => {
    const { service } = build();
    await service.onModuleInit();

    await expect(service.authorize('nobody', 'users', 'read')).resolves.toBe(
      false,
    );
  });

  it('denies unknown permissions and actions', async () => {
    const { service } = build();
    await service.onModuleInit();

    await expect(service.authorize('root', 'billing', 'read')).resolves.toBe(
      false,
    );
    await expect(service.authorize('root', 'users', 'purge')).resolves.toBe(
      false,
    );
  });

  it('normalizes the permission and action to lowercase', async () => {
    const { service } = build();
    await service.onModuleInit();

    await expect(service.authorize('alice', ' USERS ', 'Read')).resolves.toBe(
      true,
    );
  });

  it('removes access when the user roles are emptied', async () => {
    const { service, state } = build();
    await service.onModuleInit();
    await expect(service.authorize('alice', 'users', 'read')).resolves.toBe(
      true,
    );

    state.policy.userRoles = state.policy.userRoles.filter(
      (row) => row.userId !== 'alice',
    );
    state.policy.version = 2;

    await expect(service.authorize('alice', 'users', 'read')).resolves.toBe(
      false,
    );
  });
});

describe('PolicySnapshotService versioning', () => {
  it('loads the snapshot on startup', async () => {
    const { service, dataSource } = build();

    await service.onModuleInit();

    expect(service.version).toBe(1);
    expect(dataSource.transaction).toHaveBeenCalledWith(
      'REPEATABLE READ',
      expect.any(Function),
    );
  });

  it('does not reload while the version is unchanged', async () => {
    const { service, manager } = build();
    await service.onModuleInit();
    manager.find.mockClear();

    await service.authorize('alice', 'users', 'read');
    await service.authorize('alice', 'users', 'read');

    expect(manager.find).not.toHaveBeenCalled();
  });

  it('reloads once on a version mismatch without a restart', async () => {
    const { service, state, manager } = build();
    await service.onModuleInit();
    manager.find.mockClear();

    state.policy.version = 5;
    await service.authorize('alice', 'users', 'read');
    await service.authorize('alice', 'users', 'read');

    expect(service.version).toBe(5);
    expect(manager.find).toHaveBeenCalledTimes(3); // one load = 3 queries
  });

  it('shares one load between concurrent reloads', async () => {
    const { service, dataSource } = build();
    dataSource.transaction.mockClear();

    await Promise.all([service.reload(), service.reload(), service.reload()]);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });
});

describe('PolicySnapshotService unavailability', () => {
  it('answers 503 when the startup load failed, then recovers', async () => {
    const { service, state } = build();
    state.loadFails = true;
    await service.onModuleInit();

    await expect(
      service.authorize('root', 'users', 'read'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    state.loadFails = false;
    await expect(service.authorize('root', 'users', 'read')).resolves.toBe(
      true,
    );
  });

  it('answers 503 when the version cannot be read', async () => {
    const { service, state } = build();
    await service.onModuleInit();

    state.versionReadFails = true;

    await expect(
      service.authorize('root', 'users', 'read'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('answers 503 when the reloaded snapshot is older than the stored version', async () => {
    const { service, manager } = build();
    // The version check sees 5, but the load only finds version 1.
    manager.findOneBy.mockResolvedValueOnce({ id: 1, version: 5 });

    await expect(
      service.authorize('root', 'users', 'read'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('answers 503 when the version row disappears during the load', async () => {
    const { service, manager } = build();
    manager.findOneBy
      .mockResolvedValueOnce({ id: 1, version: 1 })
      .mockResolvedValueOnce(null);

    await expect(
      service.authorize('root', 'users', 'read'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('ignores grants that point to an unknown permission', async () => {
    const policy = basePolicy();
    policy.grants.push({
      roleId: 'reader',
      permissionId: 'p-ghost',
      allActions: true,
      actions: [],
    });
    const { service } = build(policy);

    await expect(service.authorize('alice', 'users', 'read')).resolves.toBe(
      true,
    );
    await expect(service.authorize('alice', 'ghost', 'read')).resolves.toBe(
      false,
    );
  });

  it('answers 503 when the version row is missing', async () => {
    const { service, manager } = build();
    manager.findOneBy.mockResolvedValue(null);

    await expect(
      service.authorize('root', 'users', 'read'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('drops the old snapshot when a reload fails, so it cannot serve stale access', async () => {
    const { service, state } = build();
    await service.onModuleInit();

    state.policy.version = 2;
    state.loadFails = true;

    await expect(
      service.authorize('root', 'users', 'read'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(service.version).toBeNull();
  });

  it('never allows access when the policy is unavailable', async () => {
    const { service, state } = build();
    state.loadFails = true;
    await service.onModuleInit();

    const outcome = await service
      .authorize('root', 'users', 'read')
      .catch((error: unknown) => error);

    expect(outcome).not.toBe(true);
  });
});
