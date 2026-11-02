import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';

import { User } from '@/modules/users/entities/user.entity';

import { GrantDto } from './dto/grant.dto';
import { PermissionDto } from './dto/permission.dto';
import { RoleDto } from './dto/role.dto';
import { Permission } from './entities/permission.entity';
import { RoleGrant } from './entities/role-grant.entity';
import { Role } from './entities/role.entity';
import { UserRole } from './entities/user-role.entity';
import { PolicySnapshotService } from './policy-snapshot.service';
import { bumpPolicyVersion, lockPolicyVersion } from './policy-version';
import { RBAC_MANAGE_ACTION, RBAC_PERMISSION } from './rbac.constants';
import { normalizeDescription } from './rbac.utils';

const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';

export interface RoleResponse {
  id: string;
  name: string;
  description: string | null;
}

export interface PermissionResponse extends RoleResponse {
  actions: string[];
}

export interface GrantResponse {
  id: string;
  roleId: string;
  permissionId: string;
  allActions: boolean;
  actions: string[];
}

export interface UserRolesResponse {
  userId: string;
  roleIds: string[];
}

/**
 * Admin operations on roles, permissions, grants and user roles.
 * Every change runs in one transaction together with the policy version bump,
 * serialized by a row lock on the version, and refreshes the snapshot after commit.
 */
@Injectable()
export class RbacAdminService {
  private readonly logger = new Logger(RbacAdminService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly snapshot: PolicySnapshotService,
  ) {}

  /* ---------------------------------- roles --------------------------------- */

  listRoles(): Promise<RoleResponse[]> {
    return this.read(async (m) =>
      (await m.find(Role, { order: { name: 'ASC' } })).map(toRole),
    );
  }

  getRole(id: string): Promise<RoleResponse> {
    return this.read(async (m) => toRole(await this.requireRole(m, id)));
  }

  createRole(dto: RoleDto): Promise<RoleResponse> {
    return this.mutate(async (m) => {
      await this.assertNameFree(m, Role, dto.name);
      const role = await m.save(
        m.create(Role, {
          name: dto.name,
          description: normalizeDescription(dto.description),
        }),
      );
      return toRole(role);
    });
  }

  updateRole(id: string, dto: RoleDto): Promise<RoleResponse> {
    return this.mutate(async (m) => {
      const role = await this.requireRole(m, id);
      await this.assertNameFree(m, Role, dto.name, role.id);
      role.name = dto.name;
      role.description = normalizeDescription(dto.description);
      return toRole(await m.save(role));
    });
  }

  deleteRole(id: string): Promise<void> {
    return this.mutate(async (m) => {
      const role = await this.requireRole(m, id);
      const [grants, users] = await Promise.all([
        m.countBy(RoleGrant, { roleId: id }),
        m.countBy(UserRole, { roleId: id }),
      ]);
      if (grants > 0 || users > 0) {
        throw new ConflictException(
          'Role still has permissions or users attached',
        );
      }
      await m.remove(role);
    });
  }

  /* ------------------------------- permissions ------------------------------ */

  listPermissions(): Promise<PermissionResponse[]> {
    return this.read(async (m) =>
      (await m.find(Permission, { order: { name: 'ASC' } })).map(toPermission),
    );
  }

  getPermission(id: string): Promise<PermissionResponse> {
    return this.read(async (m) =>
      toPermission(await this.requirePermission(m, id)),
    );
  }

  createPermission(dto: PermissionDto): Promise<PermissionResponse> {
    return this.mutate(async (m) => {
      const actions = uniqueActions(dto.actions);
      await this.assertNameFree(m, Permission, dto.name);
      const permission = await m.save(
        m.create(Permission, {
          name: dto.name,
          description: normalizeDescription(dto.description),
          actions,
        }),
      );
      return toPermission(permission);
    });
  }

  updatePermission(
    id: string,
    dto: PermissionDto,
  ): Promise<PermissionResponse> {
    return this.mutate(async (m) => {
      const permission = await this.requirePermission(m, id);
      const actions = uniqueActions(dto.actions);
      await this.assertNameFree(m, Permission, dto.name, permission.id);

      // Grants for all actions follow the new list; explicit grants must stay valid.
      const explicit = await m.findBy(RoleGrant, {
        permissionId: id,
        allActions: false,
      });
      const keep = new Set(actions);
      if (explicit.some((grant) => grant.actions.some((a) => !keep.has(a)))) {
        throw new ConflictException(
          'An action to remove is used by an explicit grant',
        );
      }

      permission.name = dto.name;
      permission.description = normalizeDescription(dto.description);
      permission.actions = actions;
      return toPermission(await m.save(permission));
    });
  }

  deletePermission(id: string): Promise<void> {
    return this.mutate(async (m) => {
      const permission = await this.requirePermission(m, id);
      if ((await m.countBy(RoleGrant, { permissionId: id })) > 0) {
        throw new ConflictException('Permission is still referenced by grants');
      }
      await m.remove(permission);
    });
  }

  /* --------------------------------- grants --------------------------------- */

  listGrants(): Promise<GrantResponse[]> {
    return this.read(async (m) => {
      const [grants, permissions] = await Promise.all([
        m.find(RoleGrant, { order: { createdAt: 'ASC' } }),
        m.find(Permission),
      ]);
      const byId = new Map(permissions.map((p) => [p.id, p]));
      return grants.flatMap((grant) => {
        const permission = byId.get(grant.permissionId);
        return permission ? [toGrant(grant, permission)] : [];
      });
    });
  }

  getGrant(id: string): Promise<GrantResponse> {
    return this.read(async (m) => {
      const grant = await this.requireGrant(m, id);
      return toGrant(
        grant,
        await this.requirePermission(m, grant.permissionId),
      );
    });
  }

  createGrant(dto: GrantDto): Promise<GrantResponse> {
    return this.mutate(async (m) => {
      const permission = await this.requireRefs(m, dto);
      await this.assertPairFree(m, dto);
      const grant = await m.save(
        m.create(RoleGrant, {
          roleId: dto.roleId,
          permissionId: dto.permissionId,
          ...this.grantActions(permission, dto.actions),
        }),
      );
      return toGrant(grant, permission);
    });
  }

  updateGrant(id: string, dto: GrantDto): Promise<GrantResponse> {
    return this.mutate(async (m) => {
      const grant = await this.requireGrant(m, id);
      const permission = await this.requireRefs(m, dto);
      await this.assertPairFree(m, dto, grant.id);
      Object.assign(grant, {
        roleId: dto.roleId,
        permissionId: dto.permissionId,
        ...this.grantActions(permission, dto.actions),
      });
      return toGrant(await m.save(grant), permission);
    });
  }

  deleteGrant(id: string): Promise<void> {
    return this.mutate(async (m) => {
      await m.remove(await this.requireGrant(m, id));
    });
  }

  /* -------------------------------- user roles ------------------------------ */

  getUserRoles(userId: string): Promise<UserRolesResponse> {
    return this.read(async (m) => {
      await this.requireUser(m, userId);
      return { userId, roleIds: await this.roleIdsOf(m, userId) };
    });
  }

  /** Replaces the full list; an empty list removes all access. */
  setUserRoles(userId: string, roleIds: string[]): Promise<UserRolesResponse> {
    return this.mutate(async (m) => {
      if (new Set(roleIds).size !== roleIds.length) {
        throw new BadRequestException('roleIds contains duplicates');
      }
      await this.requireUser(m, userId);
      if (roleIds.length > 0) {
        const found = await m.countBy(Role, { id: In(roleIds) });
        if (found !== roleIds.length) {
          throw new BadRequestException('roleIds contains unknown roles');
        }
      }
      await m.delete(UserRole, { userId });
      if (roleIds.length > 0) {
        await m.insert(
          UserRole,
          roleIds.map((roleId) => ({ userId, roleId })),
        );
      }
      return { userId, roleIds: await this.roleIdsOf(m, userId) };
    });
  }

  /* --------------------------------- helpers -------------------------------- */

  /** Runs a policy change atomically with the version bump. */
  private async mutate<T>(
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    let value: T;
    try {
      value = await this.dataSource.transaction(async (manager) => {
        await lockPolicyVersion(manager);
        const hadManager = await this.hasManageHolder(manager);
        const result = await work(manager);
        if (hadManager && !(await this.hasManageHolder(manager))) {
          throw new ConflictException(
            `The change would leave no user with ${RBAC_PERMISSION}@${RBAC_MANAGE_ACTION}`,
          );
        }
        await bumpPolicyVersion(manager);
        return result;
      });
    } catch (error) {
      throw this.translate(error);
    }

    try {
      await this.snapshot.reload();
    } catch {
      // Committed but not loaded: the snapshot service logged it and protected
      // operations answer 503 until the next successful reload.
    }
    return value;
  }

  private async read<T>(
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    try {
      return await work(this.dataSource.manager);
    } catch (error) {
      throw this.translate(error);
    }
  }

  /** Domain errors pass through; constraint races become 409; anything else is 503. */
  private translate(error: unknown): HttpException {
    if (error instanceof HttpException) {
      return error;
    }
    const code = (error as { driverError?: { code?: string } })?.driverError
      ?.code;
    if (code === PG_UNIQUE_VIOLATION || code === PG_FOREIGN_KEY_VIOLATION) {
      return new ConflictException('The change conflicts with existing data');
    }
    this.logger.error({
      event: 'rbac.admin.storage_failed',
      error: (error as Error).message,
    });
    return new ServiceUnavailableException('Storage is unavailable');
  }

  private async hasManageHolder(manager: EntityManager): Promise<boolean> {
    const rows: unknown[] = await manager.query(
      `SELECT 1 FROM user_roles ur
         JOIN role_grants g ON g.role_id = ur.role_id
         JOIN permissions p ON p.id = g.permission_id
        WHERE p.name = $1 AND $2 = ANY (p.actions)
          AND (g.all_actions OR $2 = ANY (g.actions))
        LIMIT 1`,
      [RBAC_PERMISSION, RBAC_MANAGE_ACTION],
    );
    return rows.length > 0;
  }

  private async requireRole(manager: EntityManager, id: string): Promise<Role> {
    const role = await manager.findOneBy(Role, { id });
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  private async requirePermission(
    manager: EntityManager,
    id: string,
  ): Promise<Permission> {
    const permission = await manager.findOneBy(Permission, { id });
    if (!permission) throw new NotFoundException('Permission not found');
    return permission;
  }

  private async requireGrant(
    manager: EntityManager,
    id: string,
  ): Promise<RoleGrant> {
    const grant = await manager.findOneBy(RoleGrant, { id });
    if (!grant) throw new NotFoundException('Grant not found');
    return grant;
  }

  private async requireUser(manager: EntityManager, id: string): Promise<void> {
    if (!(await manager.existsBy(User, { id }))) {
      throw new NotFoundException('User not found');
    }
  }

  /** Both referenced entities must exist; returns the permission. */
  private async requireRefs(
    manager: EntityManager,
    dto: GrantDto,
  ): Promise<Permission> {
    await this.requireRole(manager, dto.roleId);
    return this.requirePermission(manager, dto.permissionId);
  }

  private async assertNameFree(
    manager: EntityManager,
    entity: typeof Role | typeof Permission,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const existing = await manager.findOne(entity, {
      where: { name },
      select: { id: true },
    });
    if (existing && existing.id !== exceptId) {
      throw new ConflictException('Name is already in use');
    }
  }

  private async assertPairFree(
    manager: EntityManager,
    dto: GrantDto,
    exceptId?: string,
  ): Promise<void> {
    const existing = await manager.findOneBy(RoleGrant, {
      roleId: dto.roleId,
      permissionId: dto.permissionId,
    });
    if (existing && existing.id !== exceptId) {
      throw new ConflictException(
        'This role already has a grant for the permission',
      );
    }
  }

  /** No or empty actions mean all current and future actions. */
  private grantActions(
    permission: Permission,
    requested: string[] | undefined,
  ): Pick<RoleGrant, 'allActions' | 'actions'> {
    if (!requested || requested.length === 0) {
      return { allActions: true, actions: [] };
    }
    const actions = uniqueActions(requested);
    const supported = new Set(permission.actions);
    if (actions.some((action) => !supported.has(action))) {
      throw new BadRequestException('actions must belong to the permission');
    }
    return { allActions: false, actions };
  }

  private async roleIdsOf(
    manager: EntityManager,
    userId: string,
  ): Promise<string[]> {
    const rows = await manager.findBy(UserRole, { userId });
    return rows.map((row) => row.roleId).sort();
  }
}

function uniqueActions(actions: string[]): string[] {
  if (new Set(actions).size !== actions.length) {
    throw new BadRequestException('actions contains duplicates');
  }
  return actions;
}

function toRole(role: Role): RoleResponse {
  return { id: role.id, name: role.name, description: role.description };
}

function toPermission(permission: Permission): PermissionResponse {
  return { ...toRole(permission), actions: permission.actions };
}

function toGrant(grant: RoleGrant, permission: Permission): GrantResponse {
  return {
    id: grant.id,
    roleId: grant.roleId,
    permissionId: grant.permissionId,
    allActions: grant.allActions,
    actions: grant.allActions ? permission.actions : grant.actions,
  };
}
