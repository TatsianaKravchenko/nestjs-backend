import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Role } from './entities/role.entity';
import { UserRole } from './entities/user-role.entity';
import { bumpPolicyVersion, lockPolicyVersion } from './policy-version';
import { DEFAULT_ROLE } from './rbac.constants';

/** Gives newly activated users the default `user` role. */
@Injectable()
export class DefaultRoleService {
  private readonly logger = new Logger(DefaultRoleService.name);

  /**
   * Runs inside the caller's transaction, so the activation and the role
   * commit together. The policy row is locked first, the same order admin
   * changes use, which keeps the two from deadlocking.
   * A missing `user` role is skipped: an admin removed it on purpose.
   */
  async assign(manager: EntityManager, userId: string): Promise<void> {
    await lockPolicyVersion(manager);

    const role = await manager.findOneBy(Role, { name: DEFAULT_ROLE });
    if (!role) {
      this.logger.warn({
        event: 'rbac.default_role.missing',
        role: DEFAULT_ROLE,
        userId,
      });
      return;
    }

    const inserted = await manager
      .createQueryBuilder()
      .insert()
      .into(UserRole)
      .values({ userId, roleId: role.id })
      .orIgnore()
      .returning('user_id')
      .execute();

    if ((inserted.raw as unknown[]).length > 0) {
      const policyVersion = await bumpPolicyVersion(manager);
      this.logger.log({
        event: 'rbac.default_role.assigned',
        userId,
        role: DEFAULT_ROLE,
        policyVersion,
      });
    }
  }
}
