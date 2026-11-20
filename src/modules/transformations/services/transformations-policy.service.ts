import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Permission } from '@/modules/rbac/entities/permission.entity';
import { RoleGrant } from '@/modules/rbac/entities/role-grant.entity';
import { Role } from '@/modules/rbac/entities/role.entity';
import { PolicySnapshotService } from '@/modules/rbac/policy-snapshot.service';
import {
  bumpPolicyVersion,
  lockPolicyVersion,
} from '@/modules/rbac/policy-version';
import { RbacBootstrapService } from '@/modules/rbac/rbac-bootstrap.service';
import {
  ADMIN_ROLE,
  DEFAULT_ROLE,
  TRANSFORMATIONS_ACTIONS,
  TRANSFORMATIONS_PERMISSION,
  TRANSFORMATIONS_USER_ACTIONS,
} from '@/modules/rbac/rbac.constants';

export type PolicySetupResult =
  /** The permission was created and granted just now. */
  | 'created'
  /** The permission exists: nothing is changed, removed grants stay removed. */
  | 'exists'
  /** The `user` role is missing: nothing was created. */
  | 'user_role_missing';

/**
 * One-time setup of the `transformations` permission. While it does not exist,
 * it is created with its five actions; `user` gets `convert`, `history` and
 * `download`, and `admin` (when the role exists) gets every action, including
 * future ones. Once the permission exists nothing is re-applied, so an
 * administrator's later changes survive restarts.
 */
@Injectable()
export class TransformationsPolicyService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TransformationsPolicyService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly snapshot: PolicySnapshotService,
    private readonly rbacBootstrap: RbacBootstrapService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      // Another module's bootstrap hook may not have run yet; the initial RBAC
      // setup is idempotent and serialized by the policy lock, so run it first.
      if (await this.rbacBootstrap.bootstrap()) await this.snapshot.reload();
      if ((await this.ensure()) === 'created') await this.snapshot.reload();
    } catch (error) {
      this.logger.error({
        event: 'transformations.policy.setup_failed',
        error: (error as Error).message,
      });
    }
  }

  async ensure(): Promise<PolicySetupResult> {
    return this.dataSource.transaction(async (manager) => {
      await lockPolicyVersion(manager);
      if (
        await manager.existsBy(Permission, {
          name: TRANSFORMATIONS_PERMISSION,
        })
      ) {
        return 'exists';
      }

      const userRole = await manager.findOneBy(Role, { name: DEFAULT_ROLE });
      if (!userRole) {
        this.logger.error({
          event: 'transformations.policy.user_role_missing',
          role: DEFAULT_ROLE,
        });
        return 'user_role_missing';
      }
      const adminRole = await manager.findOneBy(Role, { name: ADMIN_ROLE });

      const permission = await manager.save(
        manager.create(Permission, {
          name: TRANSFORMATIONS_PERMISSION,
          description: 'File transformations and their history',
          actions: TRANSFORMATIONS_ACTIONS,
        }),
      );
      await manager.save(RoleGrant, [
        manager.create(RoleGrant, {
          roleId: userRole.id,
          permissionId: permission.id,
          allActions: false,
          actions: TRANSFORMATIONS_USER_ACTIONS,
        }),
        ...(adminRole
          ? [
              manager.create(RoleGrant, {
                roleId: adminRole.id,
                permissionId: permission.id,
                allActions: true,
                actions: [],
              }),
            ]
          : []),
      ]);

      const policyVersion = await bumpPolicyVersion(manager);
      this.logger.log({
        event: 'transformations.policy.created',
        policyVersion,
        adminGranted: Boolean(adminRole),
      });
      return 'created';
    });
  }
}
