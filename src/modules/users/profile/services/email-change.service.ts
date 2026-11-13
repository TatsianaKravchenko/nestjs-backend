import { Injectable } from '@nestjs/common';
import {
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'crypto';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager, IsNull } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import {
  CHALLENGE_TTL_SECONDS,
  MAX_OTP_ATTEMPTS,
  RESEND_AFTER_SECONDS,
} from '@/modules/auth/constants/auth.constants';
import { ConfirmationMethod } from '@/modules/auth/entities/registration-attempt.entity';
import {
  conflict,
  ApiErrorCode,
  emailChangeDeliveryUnavailable,
  emailInUse,
  invalidConfirmation,
  invalidRequest,
  invalidSession,
  registrationAttemptsExhausted,
  requestRateLimited,
} from '@/modules/auth/errors/auth.errors';
import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';
import { MailService } from '@/modules/auth/services/mail.service';

import { UserProfileDto } from '../../dto/user-profile.dto';
import {
  EmailChangeChallenge,
  EmailChangeConsumedReason as Reason,
} from '../../entities/email-change-challenge.entity';
import { User, UserStatus } from '../../entities/user.entity';
import { toUserProfile } from '../../user-profile.projector';
import { UsersService } from '../../users.service';
import {
  ConfirmEmailChangeDto,
  ResendEmailChangeDto,
  StartEmailChangeDto,
} from '../dto/update-user.dto';
import { MutationLimiter } from './mutation-limiter.service';
import {
  isUniqueViolation,
  LOCK,
  publicBaseUrl,
  withDb,
} from '../utils/profile-support';

export interface EmailChangeContext {
  requestId: string;
  userId: string;
}

export interface EmailChangeAccepted {
  confirmationRequired: true;
  method: ConfirmationMethod;
  challengeId: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

type Prepared =
  | {
      kind: 'ok';
      challenge: EmailChangeChallenge;
      email: string;
      secret: string;
    }
  | { kind: 'inactive' }
  | { kind: 'throttled'; retryAfter: number }
  | { kind: 'invalid' }
  | { kind: 'exhausted' }
  | { kind: 'conflict' }
  | { kind: 'same' }
  | { kind: 'taken' };

type Confirmed =
  | { kind: 'ok'; user: User }
  | { kind: 'invalid'; reason: string }
  | { kind: 'exhausted' }
  | { kind: 'inactive' }
  | { kind: 'conflict' }
  | { kind: 'taken' };

interface Parsed {
  challengeId: string;
  secret: string;
  method: ConfirmationMethod;
}

/**
 * Self-service email change: a challenge (OTP or magic link, chosen by the
 * server) sent to the new address and confirmed with the same session.
 * Lock order is always user row, then challenge row. The challenge is
 * committed before SMTP is contacted. Only the HMAC of the secret is stored;
 * addresses, secrets and tokens never reach the log.
 */
@Injectable()
export class EmailChangeService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly limiter: MutationLimiter,
    private readonly audit: AuthAuditService,
  ) {}

  async start(
    ctx: EmailChangeContext,
    dto: StartEmailChangeDto,
  ): Promise<EmailChangeAccepted> {
    const newEmail = UsersService.normalizeEmail(dto.newEmail);
    this.assertEmailBudget(ctx);
    const method = this.method();
    const challengeId = randomUUID();
    const secret = this.generateSecret(method);

    const result = await withDb(this.audit, ctx, () =>
      this.dataSource.transaction(async (manager): Promise<Prepared> => {
        const user = await manager.findOne(User, {
          where: { id: ctx.userId },
          lock: LOCK,
        });
        if (!user || user.status !== UserStatus.ACTIVE) {
          return { kind: 'inactive' };
        }
        if (user.email === newEmail) return { kind: 'same' };
        if (await manager.existsBy(User, { email: newEmail })) {
          return { kind: 'taken' };
        }
        const previous = await manager.findOne(EmailChangeChallenge, {
          where: { userId: user.id, consumedAt: IsNull() },
          lock: LOCK,
        });
        if (previous) {
          const retryAfter = this.retryAfter(previous.lastSentAt);
          if (retryAfter > 0) return { kind: 'throttled', retryAfter };
          this.consume(previous, Reason.REPLACED);
          await manager.save(previous);
        }
        const challenge = await manager.save(
          manager.create(EmailChangeChallenge, {
            id: challengeId,
            userId: user.id,
            newEmail,
            method,
            secretHash: this.hash(challengeId, secret),
            attempts: 0,
            lastSentAt: new Date(),
            consumedAt: null,
            consumedReason: null,
          }),
        );
        return { kind: 'ok', challenge, email: newEmail, secret };
      }),
    );

    if (result.kind !== 'ok') this.rejectPrepared(result, ctx, 'start');
    const prepared = result;
    this.audit.info('users.email_change.created', {
      requestId: ctx.requestId,
      actorUserId: ctx.userId,
      challengeId,
      method,
    });
    return this.deliver(ctx, prepared);
  }

  async resend(
    ctx: EmailChangeContext,
    dto: ResendEmailChangeDto,
  ): Promise<EmailChangeAccepted> {
    this.assertEmailBudget(ctx);
    const result = await withDb(this.audit, ctx, () =>
      this.dataSource.transaction(async (manager): Promise<Prepared> => {
        const user = await manager.findOne(User, {
          where: { id: ctx.userId },
          lock: LOCK,
        });
        if (!user || user.status !== UserStatus.ACTIVE) {
          return { kind: 'inactive' };
        }
        const challenge = isUUID(dto.challengeId)
          ? await manager.findOne(EmailChangeChallenge, {
              where: { id: dto.challengeId, userId: user.id },
              lock: LOCK,
            })
          : null;
        if (!challenge) return { kind: 'invalid' };
        const blocked = this.consumedOutcome(challenge);
        if (blocked) return blocked;

        const retryAfter = this.retryAfter(challenge.lastSentAt);
        if (retryAfter > 0) return { kind: 'throttled', retryAfter };

        const secret = this.generateSecret(challenge.method);
        challenge.secretHash = this.hash(challenge.id, secret);
        challenge.lastSentAt = new Date();
        challenge.attempts = 0;
        await manager.save(challenge);
        return { kind: 'ok', challenge, email: challenge.newEmail, secret };
      }),
    );

    if (result.kind !== 'ok') this.rejectPrepared(result, ctx, 'resend');
    const prepared = result;
    this.audit.info('users.email_change.resend', {
      requestId: ctx.requestId,
      actorUserId: ctx.userId,
      challengeId: prepared.challenge.id,
      method: prepared.challenge.method,
    });
    return this.deliver(ctx, prepared);
  }

  async confirm(
    ctx: EmailChangeContext,
    dto: ConfirmEmailChangeDto,
  ): Promise<UserProfileDto> {
    const parsed = this.parse(dto);
    if (!parsed) {
      this.audit.warn('users.email_change.confirm_failed', {
        requestId: ctx.requestId,
        actorUserId: ctx.userId,
        reason: 'malformed',
      });
      throw invalidConfirmation();
    }
    const log = {
      requestId: ctx.requestId,
      actorUserId: ctx.userId,
      challengeId: parsed.challengeId,
      method: parsed.method,
    };

    const outcome = await withDb(this.audit, ctx, () =>
      this.dataSource.transaction((manager) =>
        this.confirmIn(manager, ctx, parsed),
      ),
    );

    switch (outcome.kind) {
      case 'ok':
        this.audit.info('users.email_change.confirmed', log);
        return toUserProfile(outcome.user, publicBaseUrl(this.config));
      case 'exhausted':
        this.audit.warn('users.email_change.exhausted', log);
        throw registrationAttemptsExhausted();
      case 'inactive':
        this.audit.warn('users.email_change.confirm_failed', {
          ...log,
          reason: 'user_inactive',
        });
        throw invalidSession();
      case 'conflict':
      case 'taken':
        this.audit.warn('users.email_change.conflict', log);
        throw outcome.kind === 'taken'
          ? emailInUse()
          : conflict(
              ApiErrorCode.EmailChangeConflict,
              'The new email is no longer available or the change was replaced by an administrator',
            );
      default:
        this.audit.warn('users.email_change.confirm_failed', {
          ...log,
          reason: outcome.reason,
        });
        throw invalidConfirmation();
    }
  }

  /* --------------------------------- steps --------------------------------- */

  private async confirmIn(
    manager: EntityManager,
    ctx: EmailChangeContext,
    parsed: Parsed,
  ): Promise<Confirmed> {
    const user = await manager.findOne(User, {
      where: { id: ctx.userId },
      lock: LOCK,
    });
    const challenge = await manager.findOne(EmailChangeChallenge, {
      where: { id: parsed.challengeId, userId: ctx.userId },
      lock: LOCK,
    });
    if (!challenge) return { kind: 'invalid', reason: 'not_found' };

    const blocked = this.consumedOutcome(challenge);
    if (blocked) {
      if (blocked.kind === 'exhausted') return { kind: 'exhausted' };
      if (blocked.kind === 'conflict') return { kind: 'conflict' };
      return { kind: 'invalid', reason: 'consumed' };
    }
    // An expired challenge does not touch the failure counter.
    if (this.isExpired(challenge))
      return { kind: 'invalid', reason: 'expired' };

    if (!user || user.status !== UserStatus.ACTIVE) {
      this.consume(challenge, Reason.USER_INACTIVE);
      await manager.save(challenge);
      return { kind: 'inactive' };
    }
    if (challenge.method !== parsed.method) {
      return { kind: 'invalid', reason: 'wrong_method' };
    }

    const matches = this.safeEqual(
      this.hash(challenge.id, parsed.secret),
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

    // Only the UPDATE is rolled back on a unique violation; the verdict stays.
    await manager.query('SAVEPOINT email_change_update');
    try {
      await manager.update(
        User,
        { id: user.id },
        { email: challenge.newEmail },
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await manager.query('ROLLBACK TO SAVEPOINT email_change_update');
      this.consume(challenge, Reason.EMAIL_CONFLICT);
      await manager.save(challenge);
      return { kind: 'taken' };
    }
    await manager.query('RELEASE SAVEPOINT email_change_update');

    this.consume(challenge, Reason.CONFIRMED);
    await manager.save(challenge);
    return {
      kind: 'ok',
      user: await manager.findOneByOrFail(User, { id: user.id }),
    };
  }

  /** Sends after the commit; SMTP trouble keeps the challenge for a resend. */
  private async deliver(
    ctx: EmailChangeContext,
    prepared: Extract<Prepared, { kind: 'ok' }>,
  ): Promise<EmailChangeAccepted> {
    const { challenge, email, secret } = prepared;
    this.limiter.recordEmail(ctx.userId);
    try {
      if (challenge.method === ConfirmationMethod.OTP) {
        await this.mail.sendEmailChangeOtp(email, secret);
      } else {
        // The token travels in the fragment, so a GET never sends it to a server.
        const url = new URL(this.config.get('EMAIL_CHANGE_MAGIC_LINK_URL'));
        url.hash = `token=${challenge.id}.${secret}`;
        await this.mail.sendEmailChangeMagicLink(email, url.toString());
      }
    } catch {
      this.audit.error('users.email_change.delivery_unavailable', {
        requestId: ctx.requestId,
        actorUserId: ctx.userId,
        challengeId: challenge.id,
        method: challenge.method,
      });
      throw emailChangeDeliveryUnavailable(
        challenge.method,
        challenge.id,
        this.retryAfter(challenge.lastSentAt),
      );
    }
    this.audit.info('users.email_change.sent', {
      requestId: ctx.requestId,
      actorUserId: ctx.userId,
      challengeId: challenge.id,
      method: challenge.method,
    });
    return {
      confirmationRequired: true,
      method: challenge.method,
      challengeId: challenge.id,
      expiresInSeconds: CHALLENGE_TTL_SECONDS,
      resendAfterSeconds: RESEND_AFTER_SECONDS,
    };
  }

  private rejectPrepared(
    result: Exclude<Prepared, { kind: 'ok' }>,
    ctx: EmailChangeContext,
    operation: 'start' | 'resend',
  ): never {
    const log = {
      requestId: ctx.requestId,
      actorUserId: ctx.userId,
      operation: `users.email_change.${operation}`,
      result: result.kind,
    };
    this.audit.warn('users.email_change.rejected', log);
    switch (result.kind) {
      case 'inactive':
        throw invalidSession();
      case 'throttled':
        throw requestRateLimited(result.retryAfter);
      case 'exhausted':
        throw registrationAttemptsExhausted();
      case 'conflict':
        throw conflict(
          ApiErrorCode.EmailChangeConflict,
          'The email change was cancelled',
        );
      case 'same':
        throw conflict(
          ApiErrorCode.EmailInUse,
          'The new email equals the current one',
        );
      case 'taken':
        throw emailInUse();
      default:
        throw invalidRequest(
          'The email change cannot be resent',
          ApiErrorCode.InvalidConfirmation,
        );
    }
  }

  /** Maps a consumed challenge to its error kind; null while it is open. */
  private consumedOutcome(
    challenge: EmailChangeChallenge,
  ): { kind: 'invalid' | 'exhausted' | 'conflict' } | null {
    if (!challenge.consumedAt) return null;
    switch (challenge.consumedReason) {
      case Reason.ATTEMPTS_EXHAUSTED:
        return { kind: 'exhausted' };
      case Reason.ADMIN_OVERRIDE:
      case Reason.EMAIL_CONFLICT:
        return { kind: 'conflict' };
      default:
        return { kind: 'invalid' };
    }
  }

  /* --------------------------------- helpers -------------------------------- */

  private assertEmailBudget(ctx: EmailChangeContext): void {
    const retryAfter = this.limiter.emailRetryAfter(ctx.userId);
    if (retryAfter > 0) {
      this.audit.warn('users.rate_limited', {
        requestId: ctx.requestId,
        actorUserId: ctx.userId,
        category: 'rate_limited',
        scope: 'email_change',
        result: 'rate_limited',
        status: 429,
      });
      throw requestRateLimited(retryAfter);
    }
  }

  private parse(dto: ConfirmEmailChangeDto): Parsed | null {
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

  private consume(challenge: EmailChangeChallenge, reason: Reason): void {
    challenge.consumedAt = new Date();
    challenge.consumedReason = reason;
  }

  private isExpired(challenge: EmailChangeChallenge): boolean {
    return (
      challenge.lastSentAt.getTime() + CHALLENGE_TTL_SECONDS * 1000 <=
      Date.now()
    );
  }

  /** Whole seconds left of the pause since the last email; 0 when over. */
  private retryAfter(lastSentAt: Date): number {
    const remaining =
      lastSentAt.getTime() + RESEND_AFTER_SECONDS * 1000 - Date.now();
    return Math.max(0, Math.ceil(remaining / 1000));
  }

  private method(): ConfirmationMethod {
    return String(this.config.get('EMAIL_CHANGE_METHOD')) === 'magic_link'
      ? ConfirmationMethod.MAGIC_LINK
      : ConfirmationMethod.OTP;
  }

  private generateSecret(method: ConfirmationMethod): string {
    return method === ConfirmationMethod.OTP
      ? String(randomInt(0, 1_000_000)).padStart(6, '0')
      : randomBytes(32).toString('base64url');
  }

  /** HMAC-SHA256 under its own key; the secret is bound to its challenge id. */
  private hash(challengeId: string, secret: string): string {
    return createHmac('sha256', this.config.get('EMAIL_CHANGE_HMAC_KEY'))
      .update(`${challengeId}:${secret}`)
      .digest('hex');
  }

  private safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
