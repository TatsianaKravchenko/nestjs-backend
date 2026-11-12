import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { authorizationUnavailable } from '@/modules/auth/errors/auth.errors';

import { Permission } from './entities/permission.entity';
import { PolicyState } from './entities/policy-state.entity';
import { RoleGrant } from './entities/role-grant.entity';
import { UserRole } from './entities/user-role.entity';
import { POLICY_STATE_ID } from './rbac.constants';
import { normalizeName } from './rbac.utils';

interface GrantRule {
  allActions: boolean;
  actions: Set<string>;
}

export interface PolicySnapshot {
  version: number;
  /** permission name -> actions the permission supports */
  permissions: Map<string, Set<string>>;
  /** role id -> permission name -> grant */
  roleGrants: Map<string, Map<string, GrantRule>>;
  /** user id -> role ids */
  userRoles: Map<string, string[]>;
}

/**
 * In-memory copy of the policy. The database stays the source of truth: every
 * check compares the stored policy version with the snapshot's and reloads the
 * whole snapshot on a mismatch, so changes apply without a restart.
 * Any failure to read or load the policy denies access with 503, never allows it.
 */
@Injectable()
export class PolicySnapshotService implements OnModuleInit {
  private readonly logger = new Logger(PolicySnapshotService.name);
  private snapshot: PolicySnapshot | null = null;
  private loading: Promise<PolicySnapshot> | null = null;

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.reload();
    } catch {
      // Already logged; protected requests answer 503 until the policy loads.
    }
  }

  get version(): number | null {
    return this.snapshot?.version ?? null;
  }

  /** Union of the grants of all the user's roles. Unknown permissions or actions are denied. */
  async authorize(
    userId: string,
    permission: string,
    action: string,
  ): Promise<boolean> {
    const snapshot = await this.current();
    const name = normalizeName(permission);
    const act = normalizeName(action);

    if (!snapshot.permissions.get(name)?.has(act)) {
      return false;
    }
    return (snapshot.userRoles.get(userId) ?? []).some((roleId) => {
      const rule = snapshot.roleGrants.get(roleId)?.get(name);
      return !!rule && (rule.allActions || rule.actions.has(act));
    });
  }

  /** Loads the snapshot from the database; concurrent callers share one load. */
  reload(): Promise<PolicySnapshot> {
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async current(): Promise<PolicySnapshot> {
    const version = await this.readVersion();
    // A reload that started before the latest change may return an older
    // version, so try once more before giving up.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.snapshot && this.snapshot.version >= version) {
        return this.snapshot;
      }
      await this.reload();
    }
    if (this.snapshot && this.snapshot.version >= version) {
      return this.snapshot;
    }
    this.logger.error({
      event: 'rbac.policy.stale',
      category: 'rbac_snapshot',
      status: 503,
      policyVersion: version,
    });
    throw authorizationUnavailable();
  }

  private async readVersion(): Promise<number> {
    try {
      const state = await this.dataSource.manager.findOneBy(PolicyState, {
        id: POLICY_STATE_ID,
      });
      if (!state) {
        throw new Error('rbac_policy_state row is missing');
      }
      return state.version;
    } catch (error) {
      this.logger.error({
        event: 'rbac.policy.version_read_failed',
        category: 'rbac_version',
        status: 503,
        error: (error as Error).message,
      });
      throw authorizationUnavailable();
    }
  }

  private async load(): Promise<PolicySnapshot> {
    try {
      const snapshot = await this.dataSource.transaction(
        'REPEATABLE READ',
        async (manager) => {
          const state = await manager.findOneBy(PolicyState, {
            id: POLICY_STATE_ID,
          });
          if (!state) {
            throw new Error('rbac_policy_state row is missing');
          }
          const [permissions, grants, userRoles] = await Promise.all([
            manager.find(Permission),
            manager.find(RoleGrant),
            manager.find(UserRole),
          ]);
          return this.build(state.version, permissions, grants, userRoles);
        },
      );

      const previous = this.snapshot?.version;
      this.snapshot = snapshot;
      this.logger.log({
        event: 'rbac.policy.reloaded',
        policyVersion: snapshot.version,
        ...(previous !== undefined && previous !== snapshot.version
          ? { previousVersion: previous }
          : {}),
      });
      return snapshot;
    } catch (error) {
      // A stale snapshot must not keep answering after a failed reload.
      this.snapshot = null;
      this.logger.error({
        event: 'rbac.policy.reload_failed',
        category: 'rbac_snapshot',
        status: 503,
        error: (error as Error).message,
      });
      throw authorizationUnavailable();
    }
  }

  private build(
    version: number,
    permissions: Permission[],
    grants: RoleGrant[],
    userRoles: UserRole[],
  ): PolicySnapshot {
    const names = new Map(permissions.map((p) => [p.id, p.name]));

    const roleGrants = new Map<string, Map<string, GrantRule>>();
    for (const grant of grants) {
      const permissionName = names.get(grant.permissionId);
      if (!permissionName) continue;
      const rules =
        roleGrants.get(grant.roleId) ?? new Map<string, GrantRule>();
      rules.set(permissionName, {
        allActions: grant.allActions,
        actions: new Set(grant.actions),
      });
      roleGrants.set(grant.roleId, rules);
    }

    const roles = new Map<string, string[]>();
    for (const { userId, roleId } of userRoles) {
      roles.set(userId, [...(roles.get(userId) ?? []), roleId]);
    }

    return {
      version,
      permissions: new Map(
        permissions.map((p) => [p.name, new Set(p.actions)]),
      ),
      roleGrants,
      userRoles: roles,
    };
  }
}
