/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { ConfigService } from '@/core/config/config.service';
import { User } from '@/modules/users/entities/user.entity';

import { Permission } from './entities/permission.entity';
import { PolicyState } from './entities/policy-state.entity';
import { RoleGrant } from './entities/role-grant.entity';
import { Role } from './entities/role.entity';
import { PolicySnapshotService } from './policy-snapshot.service';
import { RbacBootstrapService } from './rbac-bootstrap.service';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';

function build(options: {
  roles?: number;
  permissions?: number;
  adminExists?: boolean;
  adminId?: string;
  reloadFails?: boolean;
}) {
  const builder = {
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ raw: [{ version: 2 }] }),
  };
  let seq = 0;
  const manager = {
    findOne: jest.fn(() => Promise.resolve({ id: 1, version: 1 })),
    count: jest.fn((entity: unknown) =>
      Promise.resolve(
        entity === Role ? (options.roles ?? 0) : (options.permissions ?? 0),
      ),
    ),
    create: jest.fn((_entity: unknown, data: object) => ({ ...data })),
    save: jest.fn((_entity: unknown, rows: object[]) =>
      Promise.resolve(rows.map((row) => ({ id: `id-${++seq}`, ...row }))),
    ),
    query: jest.fn().mockResolvedValue(undefined),
    existsBy: jest.fn().mockResolvedValue(options.adminExists ?? true),
    createQueryBuilder: jest.fn(() => builder),
  };
  const dataSource = {
    transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)),
  };
  const config = {
    get: (key: string) =>
      key === 'RBAC_BOOTSTRAP_ADMIN_USER_ID' ? options.adminId : undefined,
  };
  const snapshot = {
    reload: options.reloadFails
      ? jest.fn().mockRejectedValue(new Error('down'))
      : jest.fn().mockResolvedValue({}),
  };
  const service = new RbacBootstrapService(
    dataSource as never,
    config as unknown as ConfigService,
    snapshot as unknown as PolicySnapshotService,
  );
  return { service, manager, builder, snapshot };
}

describe('RbacBootstrapService', () => {
  it('creates permissions, roles and grants on an empty configuration', async () => {
    const { service, manager } = build({ adminId: ADMIN_ID });

    await expect(service.bootstrap()).resolves.toBe(true);

    const permissions = manager.save.mock.calls[0][1] as Permission[];
    expect(permissions.map((p) => p.name)).toEqual(['rbac', 'users']);
    expect(permissions[0].actions).toEqual(['manage']);

    const roles = manager.save.mock.calls[1][1] as Role[];
    expect(roles.map((r) => r.name)).toEqual(['user', 'admin']);

    const grants = manager.save.mock.calls[2][1] as RoleGrant[];
    const [userUsers, adminRbac, adminUsers] = grants;
    expect(userUsers).toMatchObject({
      allActions: false,
      actions: ['read', 'update', 'delete'],
    });
    expect(adminRbac).toMatchObject({ allActions: true, actions: [] });
    expect(adminUsers).toMatchObject({ allActions: true, actions: [] });
  });

  it('gives every existing active user the user role', async () => {
    const { service, manager } = build({ adminId: ADMIN_ID });

    await service.bootstrap();

    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO user_roles');
    expect(params[1]).toBe('active');
  });

  it('assigns the admin role to the configured user and bumps the version', async () => {
    const { service, manager, builder } = build({ adminId: ADMIN_ID });

    await service.bootstrap();

    expect(manager.existsBy).toHaveBeenCalledWith(User, { id: ADMIN_ID });
    expect(builder.values).toHaveBeenCalledWith(
      expect.objectContaining({ userId: ADMIN_ID }),
    );
    expect(builder.set).toHaveBeenCalled();
  });

  it('skips the admin assignment when that user does not exist', async () => {
    const { service, builder } = build({
      adminId: ADMIN_ID,
      adminExists: false,
    });

    await expect(service.bootstrap()).resolves.toBe(true);

    expect(builder.values).not.toHaveBeenCalled();
  });

  it('creates the configuration without an admin when none is configured', async () => {
    const { service, manager, builder } = build({});

    await expect(service.bootstrap()).resolves.toBe(true);

    expect(manager.existsBy).not.toHaveBeenCalled();
    expect(builder.values).not.toHaveBeenCalled();
  });

  it.each([
    ['roles', { roles: 1 }],
    ['permissions', { permissions: 1 }],
  ])('does nothing when %s already exist', async (_name, existing) => {
    const { service, manager } = build({ adminId: ADMIN_ID, ...existing });

    await expect(service.bootstrap()).resolves.toBe(false);

    expect(manager.save).not.toHaveBeenCalled();
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('locks the policy row first', async () => {
    const { service, manager } = build({});

    await service.bootstrap();

    expect(manager.findOne).toHaveBeenCalledWith(
      PolicyState,
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
  });

  describe('onApplicationBootstrap', () => {
    it('reloads the snapshot after creating the configuration', async () => {
      const { service, snapshot } = build({});

      await service.onApplicationBootstrap();

      expect(snapshot.reload).toHaveBeenCalledTimes(1);
    });

    it('does not reload when nothing was created', async () => {
      const { service, snapshot } = build({ roles: 2 });

      await service.onApplicationBootstrap();

      expect(snapshot.reload).not.toHaveBeenCalled();
    });

    it('does not crash startup when the setup fails', async () => {
      const { service, manager } = build({});
      manager.count.mockRejectedValue(new Error('db down'));

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });
});
