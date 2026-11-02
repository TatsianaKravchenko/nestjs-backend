import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import { User } from '@/modules/users/entities/user.entity';

import { Permission } from './entities/permission.entity';
import { RoleGrant } from './entities/role-grant.entity';
import { Role } from './entities/role.entity';
import { UserRole } from './entities/user-role.entity';
import { PolicySnapshotService } from './policy-snapshot.service';
import { bumpPolicyVersion, lockPolicyVersion } from './policy-version';
import {
  ADMIN_ROLE,
  DEFAULT_ROLE,
  RBAC_MANAGE_ACTION,
  RBAC_PERMISSION,
  USERS_ACTIONS,
  USERS_PERMISSION,
} from './rbac.constants';

/**
 * One-time initial setup. It only runs while the RBAC configuration is empty
 * and has no public endpoint. It creates the `rbac` and `users` permissions,
 * the `user` and `admin` roles, gives every existing active user the `user`
 * role and makes `RBAC_BOOTSTRAP_ADMIN_USER_ID` an admin.
 *
 * `user` gets only the profile actions of `users`; limiting them to the
 * user's own profile is an ownership check done by the profile endpoints.
 */
@Injectable()
export class RbacBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RbacBootstrapService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly snapshot: PolicySnapshotService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      if (await this.bootstrap()) {
        await this.snapshot.reload();
      }
    } catch (error) {
      this.logger.error({
        event: 'rbac.bootstrap.failed',
        error: (error as Error).message,
      });
    }
  }

  /** Returns true when the initial configuration was created. */
  async bootstrap(): Promise<boolean> {
    const adminUserId = String(
      this.config.get('RBAC_BOOTSTRAP_ADMIN_USER_ID') ?? '',
    ).trim();

    const created = await this.dataSource.transaction(async (manager) => {
      await lockPolicyVersion(manager);
      if (
        (await manager.count(Role)) > 0 ||
        (await manager.count(Permission)) > 0
      ) {
        return false;
      }

      const [rbac, users] = await manager.save(Permission, [
        manager.create(Permission, {
          name: RBAC_PERMISSION,
          description: 'Manage roles, permissions, grants and user roles',
          actions: [RBAC_MANAGE_ACTION],
        }),
        manager.create(Permission, {
          name: USERS_PERMISSION,
          description: 'Users and their profiles',
          actions: USERS_ACTIONS,
        }),
      ]);
      const [userRole, adminRole] = await manager.save(Role, [
        manager.create(Role, {
          name: DEFAULT_ROLE,
          description: 'Default role of every active user',
        }),
        manager.create(Role, {
          name: ADMIN_ROLE,
          description: 'Full access',
        }),
      ]);
      await manager.save(RoleGrant, [
        manager.create(RoleGrant, {
          roleId: userRole.id,
          permissionId: users.id,
          allActions: false,
          actions: ['read', 'update', 'delete'],
        }),
        manager.create(RoleGrant, {
          roleId: adminRole.id,
          permissionId: rbac.id,
          allActions: true,
          actions: [],
        }),
        manager.create(RoleGrant, {
          roleId: adminRole.id,
          permissionId: users.id,
          allActions: true,
          actions: [],
        }),
      ]);

      await manager.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT id, $1 FROM users WHERE status = $2`,
        [userRole.id, 'active'],
      );

      if (adminUserId) {
        if (await manager.existsBy(User, { id: adminUserId })) {
          await manager
            .createQueryBuilder()
            .insert()
            .into(UserRole)
            .values({ userId: adminUserId, roleId: adminRole.id })
            .orIgnore()
            .execute();
        } else {
          this.logger.warn({
            event: 'rbac.bootstrap.admin_not_found',
            userId: adminUserId,
          });
        }
      }

      const policyVersion = await bumpPolicyVersion(manager);
      this.logger.log({ event: 'rbac.bootstrap.created', policyVersion });
      return true;
    });

    if (created && !adminUserId) {
      this.logger.warn({
        event: 'rbac.bootstrap.no_admin',
        message:
          'RBAC_BOOTSTRAP_ADMIN_USER_ID is not set; no user can manage RBAC',
      });
    }
    return created;
  }
}
