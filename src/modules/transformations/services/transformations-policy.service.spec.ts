/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { Logger } from '@nestjs/common';

import { Permission } from '@/modules/rbac/entities/permission.entity';
import { RoleGrant } from '@/modules/rbac/entities/role-grant.entity';
import { Role } from '@/modules/rbac/entities/role.entity';
import {
  bumpPolicyVersion,
  lockPolicyVersion,
} from '@/modules/rbac/policy-version';

import { TransformationsPolicyService } from './transformations-policy.service';

jest.mock('@/modules/rbac/policy-version');

const USER_ROLE = { id: 'role-user', name: 'user' };
const ADMIN_ROLE = { id: 'role-admin', name: 'admin' };

describe('TransformationsPolicyService', () => {
  const manager = {
    existsBy: jest.fn(),
    findOneBy: jest.fn(),
    create: jest.fn((_type: unknown, data: object) => ({ ...data })),
    save: jest.fn(),
  };
  const dataSource = {
    transaction: jest.fn((work: (m: typeof manager) => unknown) =>
      work(manager),
    ),
  };
  const snapshot = { reload: jest.fn() };
  const rbacBootstrap = { bootstrap: jest.fn() };
  let service: TransformationsPolicyService;
  let roles: Record<string, unknown>;
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    roles = { user: USER_ROLE, admin: ADMIN_ROLE };
    manager.existsBy.mockResolvedValue(false);
    manager.findOneBy.mockImplementation(
      (_type: unknown, where: { name: string }) =>
        Promise.resolve(roles[where.name] ?? null),
    );
    manager.save.mockImplementation((first: unknown, second?: unknown) =>
      Promise.resolve(second ?? { ...(first as object), id: 'perm-1' }),
    );
    (lockPolicyVersion as jest.Mock).mockResolvedValue(1);
    (bumpPolicyVersion as jest.Mock).mockResolvedValue(2);
    rbacBootstrap.bootstrap.mockResolvedValue(false);
    service = new TransformationsPolicyService(
      dataSource as never,
      snapshot as never,
      rbacBootstrap as never,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  describe('ensure', () => {
    it('creates the permission with its five actions and grants the roles on first setup', async () => {
      await expect(service.ensure()).resolves.toBe('created');

      expect(lockPolicyVersion).toHaveBeenCalled();
      expect(manager.create).toHaveBeenCalledWith(
        Permission,
        expect.objectContaining({
          name: 'transformations',
          actions: [
            'convert',
            'history',
            'history_any',
            'download',
            'download_any',
          ],
        }),
      );
      const grants = manager.save.mock.calls.find(
        ([type]) => type === RoleGrant,
      )?.[1];
      expect(grants).toEqual([
        {
          roleId: 'role-user',
          permissionId: 'perm-1',
          allActions: false,
          actions: ['convert', 'history', 'download'],
        },
        {
          roleId: 'role-admin',
          permissionId: 'perm-1',
          allActions: true,
          actions: [],
        },
      ]);
      expect(bumpPolicyVersion).toHaveBeenCalledTimes(1);
    });

    it('does not give the user role the *_any actions', async () => {
      await service.ensure();
      const grants = manager.save.mock.calls.find(
        ([type]) => type === RoleGrant,
      )?.[1];
      expect(grants[0].actions).not.toContain('history_any');
      expect(grants[0].actions).not.toContain('download_any');
    });

    it('grants only the user role when there is no admin role', async () => {
      delete roles.admin;

      await expect(service.ensure()).resolves.toBe('created');

      const grants = manager.save.mock.calls.find(
        ([type]) => type === RoleGrant,
      )?.[1];
      expect(grants).toHaveLength(1);
      expect(grants[0].roleId).toBe('role-user');
    });

    it('does nothing when the permission already exists: removed grants are not restored', async () => {
      manager.existsBy.mockResolvedValue(true);

      await expect(service.ensure()).resolves.toBe('exists');

      expect(manager.existsBy).toHaveBeenCalledWith(Permission, {
        name: 'transformations',
      });
      expect(manager.save).not.toHaveBeenCalled();
      expect(bumpPolicyVersion).not.toHaveBeenCalled();
    });

    it('creates nothing when the user role is missing', async () => {
      delete roles.user;

      await expect(service.ensure()).resolves.toBe('user_role_missing');

      expect(manager.findOneBy).toHaveBeenCalledWith(Role, { name: 'user' });
      expect(manager.save).not.toHaveBeenCalled();
      expect(bumpPolicyVersion).not.toHaveBeenCalled();
    });
  });

  describe('onApplicationBootstrap', () => {
    it('runs the initial RBAC setup first, then its own, and reloads the policy once created', async () => {
      const order: string[] = [];
      rbacBootstrap.bootstrap.mockImplementation(() => {
        order.push('rbac');
        return Promise.resolve(true);
      });
      jest.spyOn(service, 'ensure').mockImplementation(() => {
        order.push('transformations');
        return Promise.resolve('created');
      });

      await service.onApplicationBootstrap();

      expect(order).toEqual(['rbac', 'transformations']);
      expect(snapshot.reload).toHaveBeenCalledTimes(2);
    });

    it('does not reload the policy when nothing changed', async () => {
      jest.spyOn(service, 'ensure').mockResolvedValue('exists');
      await service.onApplicationBootstrap();
      expect(snapshot.reload).not.toHaveBeenCalled();
    });

    it('does not reload when the user role is missing (readiness reports it)', async () => {
      jest.spyOn(service, 'ensure').mockResolvedValue('user_role_missing');
      await service.onApplicationBootstrap();
      expect(snapshot.reload).not.toHaveBeenCalled();
    });

    it('never fails the application start', async () => {
      rbacBootstrap.bootstrap.mockRejectedValue(new Error('db down'));
      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'transformations.policy.setup_failed',
        }),
      );
    });
  });
});
