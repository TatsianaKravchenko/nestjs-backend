import { HttpException, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { timingSafeEqual } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import { MAX_OTP_ATTEMPTS } from '@/modules/auth/constants/auth.constants';
import { ConfirmationMethod } from '@/modules/auth/entities/registration-attempt.entity';
import { LoginAttemptConsumedReason } from '@/modules/auth/entities/login-attempt.entity';
import {
  idempotencyKeyConflict,
  invalidConfirmation,
  invalidSession,
  lastAccessManager,
  notFound,
  registrationAttemptsExhausted,
  serviceUnavailable,
} from '@/modules/auth/errors/auth.errors';
import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';
import {
  bumpPolicyVersion,
  lockPolicyVersion,
} from '@/modules/rbac/policy-version';
import { hasActiveManageHolder } from '@/modules/rbac/rbac-invariant';

import { EmailChangeConsumedReason } from '../../entities/email-change-challenge.entity';
import { User, UserStatus } from '../../entities/user.entity';
import { LOCK } from '../../profile/utils/profile-support';
import type { ConfirmDeletionDto } from '../dto/deletion.dto';
import {
  DeletionChallenge,
  DeletionChallengeConsumedReason as Reason,
} from '../entities/deletion-challenge.entity';
import {
  DeletionJob,
  DeletionJobStatus,
} from '../entities/deletion-job.entity';
import {
  accepted,
  type DeletionAccepted,
  newJobId,
  newTombstoneEmail,
  withDeletionDb,
} from '../utils/deletion-support';
import { hashDeletionSecret } from './deletion-challenge.service';

export interface SelfDeletionContext {
  userId: string;
  /** The `Idempotency-Key`: becomes the job id. */
  jobId: string;
}

interface Parsed {
  challengeId: string;
  secret: string;
  method: ConfirmationMethod;
}

type Confirmed =
  | { kind: 'ok'; job: DeletionJob }
  | { kind: 'invalid'; reason: string }
  | { kind: 'exhausted' }
  | { kind: 'inactive' }
  | { kind: 'key_conflict' };

const CHALLENGE_TTL_MS = 600_000;

/**
 * Accepts a deletion: after the email challenge (own account) or directly by
 * an administrator (`users@delete_any`). Both create the single job of the
 * user, set the user `deleting` (every token stops working at once), remove the
 * role assignments and cancel open challenges in one transaction. Lock order:
 * policy state, then user, then challenge. The log carries event names and
 * results only: never ids, addresses, secrets or tokens.
 */
@Injectable()
export class DeletionRequestService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly audit: AuthAuditService,
  ) {}

  /** `POST /users/:id/deletion-confirm`. */
  async confirm(
    ctx: SelfDeletionContext,
    dto: ConfirmDeletionDto,
  ): Promise<DeletionAccepted> {
    const parsed = this.parse(dto);
    if (!parsed) {
      this.audit.warn('users.deletion.confirm', { result: 'malformed' });
      throw invalidConfirmation();
    }
    let outcome: Confirmed;
    try {
      outcome = await withDeletionDb(this.audit, () =>
        this.dataSource.transaction((manager) =>
          this.confirmIn(manager, ctx, parsed),
        ),
      );
    } catch (error) {
      this.audit.warn('users.deletion.confirm', {
        result: 'rejected',
        ...(error instanceof HttpException
          ? { status: error.getStatus() }
          : {}),
      });
      throw error;
    }

    switch (outcome.kind) {
      case 'ok':
        this.audit.info('users.deletion.confirm', { result: 'accepted' });
        return accepted(outcome.job);
      case 'exhausted':
        this.audit.warn('users.deletion.confirm', { result: 'exhausted' });
        throw registrationAttemptsExhausted();
      case 'inactive':
        this.audit.warn('users.deletion.confirm', { result: 'user_inactive' });
        throw invalidSession();
      case 'key_conflict':
        this.audit.warn('users.deletion.confirm', {
          result: 'idempotency_conflict',
        });
        throw idempotencyKeyConflict();
      default:
        this.audit.warn('users.deletion.confirm', { result: outcome.reason });
        throw invalidConfirmation();
    }
  }

  /** `DELETE /users/:id` for an administrator. A `failed` job is queued again. */
  async deleteByAdmin(targetUserId: string): Promise<DeletionAccepted> {
    let job: DeletionJob;
    try {
      job = await withDeletionDb(this.audit, () =>
        this.dataSource.transaction((manager) =>
          this.adminIn(manager, targetUserId),
        ),
      );
    } catch (error) {
      this.audit.warn('users.deletion.admin_delete', {
        result: 'rejected',
        ...(error instanceof HttpException
          ? { status: error.getStatus() }
          : {}),
      });
      throw error;
    }
    this.audit.info('users.deletion.admin_delete', { result: 'accepted' });
    return accepted(job);
  }

  /* --------------------------------- steps --------------------------------- */

  private async confirmIn(
    manager: EntityManager,
    ctx: SelfDeletionContext,
    parsed: Parsed,
  ): Promise<Confirmed> {
    await lockPolicyVersion(manager);
    const user = await manager.findOne(User, {
      where: { id: ctx.userId },
      lock: LOCK,
    });
    const challenge = await manager.findOne(DeletionChallenge, {
      where: { id: parsed.challengeId, userId: ctx.userId },
      lock: LOCK,
    });

    // The key may already name a job: the same user gets it again (a lost 202),
    // another user's key is a conflict.
    const keyed = await manager.findOne(DeletionJob, {
      where: { id: ctx.jobId },
    });
    if (keyed) {
      return keyed.userId === ctx.userId
        ? { kind: 'ok', job: keyed }
        : { kind: 'key_conflict' };
    }

    if (!challenge) return { kind: 'invalid', reason: 'not_found' };
    if (challenge.consumedAt) {
      return challenge.consumedReason === Reason.ATTEMPTS_EXHAUSTED
        ? { kind: 'exhausted' }
        : { kind: 'invalid', reason: 'consumed' };
    }
    // An expired challenge does not touch the failure counter.
    if (challenge.lastSentAt.getTime() + CHALLENGE_TTL_MS <= Date.now()) {
      return { kind: 'invalid', reason: 'expired' };
    }
    if (!user || user.status !== UserStatus.ACTIVE) {
      this.consume(challenge, Reason.USER_INACTIVE);
      await manager.save(challenge);
      return { kind: 'inactive' };
    }
    if (challenge.method !== parsed.method) {
      return { kind: 'invalid', reason: 'wrong_method' };
    }

    const matches = this.safeEqual(
      hashDeletionSecret(this.config, challenge.id, parsed.secret),
      challenge.secretHash,
    );
    if (!matches) {
      if (challenge.method === ConfirmationMethod.OTP) {
        challenge.attempts += 1;
        if (challenge.attempts >= MAX_OTP_ATTEMPTS) {
          this.consume(challenge, Reason.ATTEMPTS_EXHAUSTED);
        }
        await manager.save(challenge);
      }
      return { kind: 'invalid', reason: 'mismatch' };
    }

    // Another job of this user wins: the challenge is spent, its job is returned.
    const existing = await manager.findOne(DeletionJob, {
      where: { userId: user.id },
    });
    if (existing) {
      this.consume(challenge, Reason.JOB_EXISTS);
      await manager.save(challenge);
      return { kind: 'ok', job: existing };
    }

    await this.assertNotLastManager(manager, user.id);
    const job = await this.createJob(manager, user.id, ctx.jobId);
    this.consume(challenge, Reason.CONFIRMED);
    await manager.save(challenge);
    return { kind: 'ok', job };
  }

  private async adminIn(
    manager: EntityManager,
    targetUserId: string,
  ): Promise<DeletionJob> {
    await lockPolicyVersion(manager);
    const user = isUUID(targetUserId)
      ? await manager.findOne(User, {
          where: { id: targetUserId },
          lock: LOCK,
        })
      : null;
    if (!user) throw notFound('User not found');

    const existing = await manager.findOne(DeletionJob, {
      where: { userId: user.id },
      lock: LOCK,
    });
    if (existing) {
      if (existing.status === DeletionJobStatus.FAILED) {
        existing.status = DeletionJobStatus.QUEUED;
        existing.attempts = 0;
        existing.leaseUntil = null;
        existing.nextAttemptAt = new Date();
        existing.lastErrorCode = null;
        return manager.save(existing);
      }
      return existing;
    }
    // pending, active and blocked users may be deleted; a pending user is no
    // `rbac@manage` holder, so the invariant check below passes for it.
    // `deleting` or `deleted` without a job cannot happen: the state is
    // inconsistent, so nothing is changed and the caller gets a retryable 503.
    if (
      user.status === UserStatus.DELETING ||
      user.status === UserStatus.DELETED
    ) {
      this.audit.error('users.deletion.consistency_violation', {
        result: 'missing_job',
      });
      throw serviceUnavailable();
    }
    await this.assertNotLastManager(manager, user.id);
    return this.createJob(manager, user.id, newJobId());
  }

  /** Only a current active holder can break the invariant by leaving. */
  private async assertNotLastManager(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    const isHolder = await hasActiveManageHolder(manager, { only: userId });
    if (
      isHolder &&
      !(await hasActiveManageHolder(manager, { exclude: userId }))
    ) {
      throw lastAccessManager();
    }
  }

  /** Caller holds the policy and user locks. */
  private async createJob(
    manager: EntityManager,
    userId: string,
    jobId: string,
  ): Promise<DeletionJob> {
    const job = await manager.save(
      manager.create(DeletionJob, {
        id: jobId,
        userId,
        status: DeletionJobStatus.QUEUED,
        tombstoneEmail: newTombstoneEmail(),
        attempts: 0,
        leaseUntil: null,
        nextAttemptAt: new Date(),
        lastErrorCode: null,
      }),
    );
    await manager.update(User, { id: userId }, { status: UserStatus.DELETING });

    const removed = await manager
      .createQueryBuilder()
      .delete()
      .from('user_roles')
      .where('user_id = :userId', { userId })
      .execute();
    if ((removed.affected ?? 0) > 0) await bumpPolicyVersion(manager);

    // Open challenges of every kind are void for a user that is going away.
    await manager.query(
      `UPDATE registration_attempts SET consumed_at = now()
        WHERE user_id = $1 AND consumed_at IS NULL`,
      [userId],
    );
    await manager.query(
      `UPDATE login_attempts SET consumed_at = now(), consumed_reason = $2
        WHERE user_id = $1 AND consumed_at IS NULL`,
      [userId, LoginAttemptConsumedReason.USER_INACTIVE],
    );
    await manager.query(
      `UPDATE email_change_challenges SET consumed_at = now(), consumed_reason = $2
        WHERE user_id = $1 AND consumed_at IS NULL`,
      [userId, EmailChangeConsumedReason.USER_INACTIVE],
    );
    await manager.query(
      `UPDATE deletion_challenges SET consumed_at = now(), consumed_reason = $2
        WHERE user_id = $1 AND consumed_at IS NULL`,
      [userId, Reason.USER_INACTIVE],
    );
    return job;
  }

  /* --------------------------------- helpers -------------------------------- */

  private parse(dto: ConfirmDeletionDto): Parsed | null {
    if (dto.token !== undefined) {
      if (dto.challengeId !== undefined || dto.code !== undefined) return null;
      const separator = dto.token.indexOf('.');
      const challengeId = dto.token.slice(0, separator);
      const secret = dto.token.slice(separator + 1);
      if (
        separator < 0 ||
        !isUUID(challengeId) ||
        !/^[A-Za-z0-9_-]{43}$/.test(secret)
      ) {
        return null;
      }
      return { challengeId, secret, method: ConfirmationMethod.MAGIC_LINK };
    }
    if (
      dto.challengeId !== undefined &&
      dto.code !== undefined &&
      isUUID(dto.challengeId)
    ) {
      return {
        challengeId: dto.challengeId,
        secret: dto.code,
        method: ConfirmationMethod.OTP,
      };
    }
    return null;
  }

  private consume(challenge: DeletionChallenge, reason: Reason): void {
    challenge.consumedAt = new Date();
    challenge.consumedReason = reason;
  }

  private safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
