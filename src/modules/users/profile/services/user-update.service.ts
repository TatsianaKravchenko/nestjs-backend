import { HttpException, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import {
  emailInUse,
  lastAccessManager,
  notFound,
  permissionDenied,
  userStateConflict,
} from '@/modules/auth/errors/auth.errors';
import { LoginAttemptConsumedReason } from '@/modules/auth/entities/login-attempt.entity';
import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';
import { lockPolicyVersion } from '@/modules/rbac/policy-version';
import { PolicySnapshotService } from '@/modules/rbac/policy-snapshot.service';
import { hasActiveManageHolder } from '@/modules/rbac/rbac-invariant';
import {
  USERS_PERMISSION,
  USERS_UPDATE_ANY_ACTION,
} from '@/modules/rbac/rbac.constants';

import { UserProfileDto } from '../../dto/user-profile.dto';
import {
  EmailChangeChallenge,
  EmailChangeConsumedReason,
} from '../../entities/email-change-challenge.entity';
import { User, UserStatus } from '../../entities/user.entity';
import { toUserProfile } from '../../user-profile.projector';
import { UsersService } from '../../users.service';
import { UpdateUserDto } from '../dto/update-user.dto';
import {
  isUniqueViolation,
  LOCK,
  MutationContext,
  publicBaseUrl,
  withDb,
} from '../utils/profile-support';

type Changes = Partial<Pick<User, 'displayName' | 'email' | 'status'>>;

interface Outcome {
  user: User;
  changed: boolean;
  transition?: string;
}

/**
 * `PATCH /users/:id`. Runs after the guards (`users@update`, `users@update_any`
 * for a foreign id). The body-dependent `users@update_any` check for `email`
 * and `status` happens here, before the target is looked up. Audit events
 * carry field names and results, never values.
 */
@Injectable()
export class UserUpdateService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly policy: PolicySnapshotService,
    private readonly audit: AuthAuditService,
    private readonly config: ConfigService,
  ) {}

  async update(
    ctx: MutationContext,
    dto: UpdateUserDto,
  ): Promise<UserProfileDto> {
    const fields = (Object.keys(dto) as (keyof UpdateUserDto)[])
      .filter((key) => dto[key] !== undefined)
      .sort();
    const log = {
      requestId: ctx.requestId,
      actorUserId: ctx.actorUserId,
      targetUserId: ctx.targetUserId,
      operation: 'users.update',
      fields: fields.join(','),
    };

    if (dto.email !== undefined || dto.status !== undefined) {
      const allowed = await this.policy.authorize(
        ctx.actorUserId,
        USERS_PERMISSION,
        USERS_UPDATE_ANY_ACTION,
      );
      if (!allowed) {
        this.audit.warn('users.update.denied', {
          ...log,
          result: 'denied',
          category: 'permission_denied',
          status: 403,
        });
        throw permissionDenied();
      }
    }

    let outcome: Outcome;
    try {
      outcome = await withDb(this.audit, ctx, () =>
        this.dataSource.transaction((manager) => this.apply(manager, ctx, dto)),
      );
    } catch (error) {
      const status =
        error instanceof HttpException ? error.getStatus() : undefined;
      this.audit.warn('users.update.rejected', {
        ...log,
        result: 'rejected',
        ...(status ? { status } : {}),
      });
      throw error;
    }

    this.audit.info('users.update', {
      ...log,
      result: outcome.changed ? 'updated' : 'unchanged',
    });
    if (outcome.transition) {
      this.audit.info('users.status_changed', {
        requestId: ctx.requestId,
        actorUserId: ctx.actorUserId,
        targetUserId: ctx.targetUserId,
        transition: outcome.transition,
      });
    }
    return toUserProfile(outcome.user, publicBaseUrl(this.config));
  }

  private async apply(
    manager: EntityManager,
    ctx: MutationContext,
    dto: UpdateUserDto,
  ): Promise<Outcome> {
    // Lock order everywhere: policy state, then user, then challenge.
    if (dto.status === UserStatus.BLOCKED) await lockPolicyVersion(manager);

    const user = isUUID(ctx.targetUserId)
      ? await manager.findOne(User, {
          where: { id: ctx.targetUserId },
          lock: LOCK,
        })
      : null;
    if (!user) throw notFound('User not found');
    if (
      user.status !== UserStatus.ACTIVE &&
      user.status !== UserStatus.BLOCKED
    ) {
      throw userStateConflict();
    }

    const changes: Changes = {};
    if (dto.displayName !== undefined && dto.displayName !== user.displayName) {
      changes.displayName = dto.displayName;
    }
    if (dto.email !== undefined) {
      const email = UsersService.normalizeEmail(dto.email);
      if (email !== user.email) {
        if (await manager.existsBy(User, { email })) throw emailInUse();
        changes.email = email;
      }
    }
    if (dto.status !== undefined && dto.status !== user.status) {
      changes.status = dto.status;
    }
    if (Object.keys(changes).length === 0) return { user, changed: false };

    if (changes.status === UserStatus.BLOCKED) {
      // Only a current holder can break the invariant by leaving.
      const isHolder = await hasActiveManageHolder(manager, { only: user.id });
      if (
        isHolder &&
        !(await hasActiveManageHolder(manager, { exclude: user.id }))
      ) {
        throw lastAccessManager();
      }
    }

    try {
      await manager.update(User, { id: user.id }, changes);
    } catch (error) {
      if (isUniqueViolation(error)) throw emailInUse();
      throw error;
    }

    if (changes.email !== undefined) {
      await this.consumeChallenge(
        manager,
        user.id,
        EmailChangeConsumedReason.ADMIN_OVERRIDE,
      );
    }
    if (changes.status === UserStatus.BLOCKED) {
      await this.consumeChallenge(
        manager,
        user.id,
        EmailChangeConsumedReason.USER_INACTIVE,
      );
      await manager.query(
        `UPDATE login_attempts SET consumed_at = now(), consumed_reason = $2
          WHERE user_id = $1 AND consumed_at IS NULL`,
        [user.id, LoginAttemptConsumedReason.USER_INACTIVE],
      );
    }

    return {
      user: await manager.findOneByOrFail(User, { id: user.id }),
      changed: true,
      transition: changes.status
        ? `${user.status}->${changes.status}`
        : undefined,
    };
  }

  /** No-op when the user has no open challenge. */
  private async consumeChallenge(
    manager: EntityManager,
    userId: string,
    reason: EmailChangeConsumedReason,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(EmailChangeChallenge)
      .set({ consumedAt: () => 'now()', consumedReason: reason })
      .where('user_id = :userId AND consumed_at IS NULL', { userId })
      .execute();
  }
}
