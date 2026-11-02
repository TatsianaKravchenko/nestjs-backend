import { GUARDS_METADATA } from '@nestjs/common/constants';

import { GrantDto } from './dto/grant.dto';
import { PermissionDto } from './dto/permission.dto';
import { RoleDto } from './dto/role.dto';
import { RbacAdminController } from './rbac-admin.controller';
import { RbacAdminService } from './rbac-admin.service';
import { AUDIT_KEY, REQUIRED_PERMISSION_KEY } from './rbac.constants';
import { RbacGuard } from './rbac.guard';
import type { AuditMetadata } from './rbac.types';

const ID = '00000000-0000-4000-8000-000000000000';
const USER = '00000000-0000-4000-8000-000000000001';

function build() {
  const admin = {
    listRoles: jest.fn().mockResolvedValue(['roles']),
    getRole: jest.fn().mockResolvedValue('role'),
    createRole: jest.fn().mockResolvedValue('created-role'),
    updateRole: jest.fn().mockResolvedValue('updated-role'),
    deleteRole: jest.fn().mockResolvedValue(undefined),
    listPermissions: jest.fn().mockResolvedValue(['permissions']),
    getPermission: jest.fn().mockResolvedValue('permission'),
    createPermission: jest.fn().mockResolvedValue('created-permission'),
    updatePermission: jest.fn().mockResolvedValue('updated-permission'),
    deletePermission: jest.fn().mockResolvedValue(undefined),
    listGrants: jest.fn().mockResolvedValue(['grants']),
    getGrant: jest.fn().mockResolvedValue('grant'),
    createGrant: jest.fn().mockResolvedValue('created-grant'),
    updateGrant: jest.fn().mockResolvedValue('updated-grant'),
    deleteGrant: jest.fn().mockResolvedValue(undefined),
    getUserRoles: jest.fn().mockResolvedValue('user-roles'),
    setUserRoles: jest.fn().mockResolvedValue('set-user-roles'),
  };
  const controller = new RbacAdminController(
    admin as unknown as RbacAdminService,
  );
  return { controller, admin };
}

describe('RbacAdminController', () => {
  it('delegates role operations', async () => {
    const { controller, admin } = build();
    const dto = { name: 'a' } as RoleDto;

    await expect(controller.listRoles()).resolves.toEqual(['roles']);
    await expect(controller.getRole(ID)).resolves.toBe('role');
    await expect(controller.createRole(dto)).resolves.toBe('created-role');
    await expect(controller.updateRole(ID, dto)).resolves.toBe('updated-role');
    await controller.deleteRole(ID);

    expect(admin.getRole).toHaveBeenCalledWith(ID);
    expect(admin.createRole).toHaveBeenCalledWith(dto);
    expect(admin.updateRole).toHaveBeenCalledWith(ID, dto);
    expect(admin.deleteRole).toHaveBeenCalledWith(ID);
  });

  it('delegates permission operations', async () => {
    const { controller, admin } = build();
    const dto = { name: 'a', actions: ['read'] } as PermissionDto;

    await expect(controller.listPermissions()).resolves.toEqual([
      'permissions',
    ]);
    await expect(controller.getPermission(ID)).resolves.toBe('permission');
    await expect(controller.createPermission(dto)).resolves.toBe(
      'created-permission',
    );
    await expect(controller.updatePermission(ID, dto)).resolves.toBe(
      'updated-permission',
    );
    await controller.deletePermission(ID);

    expect(admin.createPermission).toHaveBeenCalledWith(dto);
    expect(admin.updatePermission).toHaveBeenCalledWith(ID, dto);
    expect(admin.deletePermission).toHaveBeenCalledWith(ID);
  });

  it('delegates grant operations', async () => {
    const { controller, admin } = build();
    const dto = { roleId: ID, permissionId: ID } as GrantDto;

    await expect(controller.listGrants()).resolves.toEqual(['grants']);
    await expect(controller.getGrant(ID)).resolves.toBe('grant');
    await expect(controller.createGrant(dto)).resolves.toBe('created-grant');
    await expect(controller.updateGrant(ID, dto)).resolves.toBe(
      'updated-grant',
    );
    await controller.deleteGrant(ID);

    expect(admin.createGrant).toHaveBeenCalledWith(dto);
    expect(admin.updateGrant).toHaveBeenCalledWith(ID, dto);
    expect(admin.deleteGrant).toHaveBeenCalledWith(ID);
  });

  it('delegates user role operations', async () => {
    const { controller, admin } = build();

    await expect(controller.getUserRoles(USER)).resolves.toBe('user-roles');
    await expect(
      controller.setUserRoles(USER, { roleIds: [ID] }),
    ).resolves.toBe('set-user-roles');

    expect(admin.getUserRoles).toHaveBeenCalledWith(USER);
    expect(admin.setUserRoles).toHaveBeenCalledWith(USER, [ID]);
  });
});

describe('RbacAdminController protection', () => {
  it('requires rbac@manage on every route through the RBAC guard', () => {
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, RbacAdminController),
    ).toEqual({ permission: 'rbac', action: 'manage' });
    expect(Reflect.getMetadata(GUARDS_METADATA, RbacAdminController)).toContain(
      RbacGuard,
    );
  });

  it('marks every write for the audit log and no read', () => {
    const proto = RbacAdminController.prototype as unknown as Record<
      string,
      () => unknown
    >;
    const audited = (name: string) =>
      Reflect.getMetadata(AUDIT_KEY, proto[name]) as AuditMetadata | undefined;

    const writes: Record<string, AuditMetadata> = {
      createRole: { entityType: 'role', operation: 'create' },
      updateRole: { entityType: 'role', operation: 'replace' },
      deleteRole: { entityType: 'role', operation: 'delete' },
      createPermission: { entityType: 'permission', operation: 'create' },
      updatePermission: { entityType: 'permission', operation: 'replace' },
      deletePermission: { entityType: 'permission', operation: 'delete' },
      createGrant: { entityType: 'grant', operation: 'create' },
      updateGrant: { entityType: 'grant', operation: 'replace' },
      deleteGrant: { entityType: 'grant', operation: 'delete' },
      setUserRoles: { entityType: 'user-roles', operation: 'replace' },
    };
    for (const [name, expected] of Object.entries(writes)) {
      expect([name, audited(name)]).toEqual([name, expected]);
    }

    for (const read of [
      'listRoles',
      'getRole',
      'listPermissions',
      'getPermission',
      'listGrants',
      'getGrant',
      'getUserRoles',
    ]) {
      expect([read, audited(read)]).toEqual([read, undefined]);
    }
  });
});
