import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes, randomInt, randomUUID } from 'crypto';
import { isUUID } from 'class-validator';
import { DataSource, IsNull } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import {
  CHALLENGE_TTL_SECONDS,
  RESEND_AFTER_SECONDS,
} from '@/modules/auth/constants/auth.constants';
import { ConfirmationMethod } from '@/modules/auth/entities/registration-attempt.entity';
import {
  deletionDeliveryUnavailable,
  invalidRequest,
  invalidSession,
  registrationAttemptsExhausted,
  requestRateLimited,
  ApiErrorCode,
} from '@/modules/auth/errors/auth.errors';
import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';
import { MailService } from '@/modules/auth/services/mail.service';

import { User, UserStatus } from '../../entities/user.entity';
import { LOCK } from '../../profile/utils/profile-support';
import type { ResendDeletionDto } from '../dto/deletion.dto';
import {
  DeletionChallenge,
  DeletionChallengeConsumedReason as Reason,
} from '../entities/deletion-challenge.entity';
import { withDeletionDb } from '../utils/deletion-support';
import { DeletionLimiter } from './deletion-limiter.service';

export interface DeletionChallengeContext {
  requestId: string;
  userId: string;
}

export interface DeletionChallengeAccepted {
  confirmationRequired: true;
  method: ConfirmationMethod;
  challengeId: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

type Prepared =
  | {
      kind: 'ok';
      challenge: DeletionChallenge;
      email: string;
      secret: string;
    }
  | { kind: 'inactive' }
  | { kind: 'throttled'; retryAfter: number }
  | { kind: 'invalid' }
  | { kind: 'exhausted' };

/** HMAC-SHA256 under its own key; the secret is bound to its challenge id. */
export function hashDeletionSecret(
  config: ConfigService,
  challengeId: string,
  secret: string,
): string {
  return createHmac('sha256', config.get('DELETION_CHALLENGE_HMAC_KEY'))
    .update(`${challengeId}:${secret}`)
    .digest('hex');
}

/**
 * Starts and resends the email challenge that confirms the deletion of the
 * own account. The challenge is committed before SMTP is contacted; only the
 * HMAC of the secret is stored. The log carries event names and results only.
 */
@Injectable()
export class DeletionChallengeService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly limiter: DeletionLimiter,
    private readonly audit: AuthAuditService,
  ) {}

  async start(
    ctx: DeletionChallengeContext,
  ): Promise<DeletionChallengeAccepted> {
    this.assertEmailBudget(ctx.userId);
    const method = this.method();
    const challengeId = randomUUID();
    const secret = this.generateSecret(method);

    const result = await withDeletionDb(this.audit, () =>
      this.dataSource.transaction(async (manager): Promise<Prepared> => {
        const user = await manager.findOne(User, {
          where: { id: ctx.userId },
          lock: LOCK,
        });
        if (!user || user.status !== UserStatus.ACTIVE) {
          return { kind: 'inactive' };
        }
        const previous = await manager.findOne(DeletionChallenge, {
          where: { userId: user.id, consumedAt: IsNull() },
          lock: LOCK,
        });
        if (previous) {
          const retryAfter = this.retryAfter(previous.lastSentAt);
          if (retryAfter > 0) return { kind: 'throttled', retryAfter };
          previous.consumedAt = new Date();
          previous.consumedReason = Reason.REPLACED;
          await manager.save(previous);
        }
        const challenge = await manager.save(
          manager.create(DeletionChallenge, {
            id: challengeId,
            userId: user.id,
            method,
            secretHash: hashDeletionSecret(this.config, challengeId, secret),
            attempts: 0,
            lastSentAt: new Date(),
            consumedAt: null,
            consumedReason: null,
          }),
        );
        return { kind: 'ok', challenge, email: user.email, secret };
      }),
    );

    if (result.kind !== 'ok') this.reject(result, 'start');
    return this.deliver(ctx, result);
  }

  async resend(
    ctx: DeletionChallengeContext,
    dto: ResendDeletionDto,
  ): Promise<DeletionChallengeAccepted> {
    this.assertEmailBudget(ctx.userId);
    const result = await withDeletionDb(this.audit, () =>
      this.dataSource.transaction(async (manager): Promise<Prepared> => {
        const user = await manager.findOne(User, {
          where: { id: ctx.userId },
          lock: LOCK,
        });
        if (!user || user.status !== UserStatus.ACTIVE) {
          return { kind: 'inactive' };
        }
        const challenge = isUUID(dto.challengeId)
          ? await manager.findOne(DeletionChallenge, {
              where: { id: dto.challengeId, userId: user.id },
              lock: LOCK,
            })
          : null;
        if (!challenge) return { kind: 'invalid' };
        if (challenge.consumedAt) {
          return challenge.consumedReason === Reason.ATTEMPTS_EXHAUSTED
            ? { kind: 'exhausted' }
            : { kind: 'invalid' };
        }
        const retryAfter = this.retryAfter(challenge.lastSentAt);
        if (retryAfter > 0) return { kind: 'throttled', retryAfter };

        const secret = this.generateSecret(challenge.method);
        challenge.secretHash = hashDeletionSecret(
          this.config,
          challenge.id,
          secret,
        );
        challenge.lastSentAt = new Date();
        challenge.attempts = 0;
        await manager.save(challenge);
        return { kind: 'ok', challenge, email: user.email, secret };
      }),
    );

    if (result.kind !== 'ok') this.reject(result, 'resend');
    return this.deliver(ctx, result);
  }

  /** Sends after the commit; SMTP trouble keeps the challenge for a resend. */
  private async deliver(
    ctx: DeletionChallengeContext,
    prepared: Extract<Prepared, { kind: 'ok' }>,
  ): Promise<DeletionChallengeAccepted> {
    const { challenge, email, secret } = prepared;
    this.limiter.recordEmail(ctx.userId);
    try {
      if (challenge.method === ConfirmationMethod.OTP) {
        await this.mail.sendDeletionOtp(email, secret);
      } else {
        // The token travels in the fragment, so a GET never sends it to a server.
        const url = new URL(this.config.get('DELETION_MAGIC_LINK_URL'));
        url.hash = `token=${challenge.id}.${secret}`;
        await this.mail.sendDeletionMagicLink(email, url.toString());
      }
    } catch {
      this.audit.error('users.deletion.challenge', {
        result: 'delivery_unavailable',
      });
      throw deletionDeliveryUnavailable(
        challenge.method,
        challenge.id,
        this.retryAfter(challenge.lastSentAt),
      );
    }
    this.audit.info('users.deletion.challenge', { result: 'sent' });
    return {
      confirmationRequired: true,
      method: challenge.method,
      challengeId: challenge.id,
      expiresInSeconds: CHALLENGE_TTL_SECONDS,
      resendAfterSeconds: RESEND_AFTER_SECONDS,
    };
  }

  private reject(
    result: Exclude<Prepared, { kind: 'ok' }>,
    operation: 'start' | 'resend',
  ): never {
    this.audit.warn(`users.deletion.challenge_${operation}`, {
      result: result.kind,
    });
    switch (result.kind) {
      case 'inactive':
        throw invalidSession();
      case 'throttled':
        throw requestRateLimited(result.retryAfter);
      case 'exhausted':
        throw registrationAttemptsExhausted();
      default:
        throw invalidRequest(
          'The challenge cannot be resent',
          ApiErrorCode.InvalidConfirmation,
        );
    }
  }

  /** 5 challenge emails per user and hour (429 with the wait). */
  private assertEmailBudget(userId: string): void {
    const retryAfter = this.limiter.emailRetryAfter(userId);
    if (retryAfter > 0) {
      this.audit.warn('users.deletion.rate_limited', {
        result: 'rate_limited',
      });
      throw requestRateLimited(retryAfter);
    }
  }

  /** Whole seconds left of the pause since the last email; 0 when over. */
  private retryAfter(lastSentAt: Date): number {
    const remaining =
      lastSentAt.getTime() + RESEND_AFTER_SECONDS * 1000 - Date.now();
    return Math.max(0, Math.ceil(remaining / 1000));
  }

  private method(): ConfirmationMethod {
    return String(this.config.get('DELETION_CONFIRMATION_METHOD')) ===
      'magic_link'
      ? ConfirmationMethod.MAGIC_LINK
      : ConfirmationMethod.OTP;
  }

  private generateSecret(method: ConfirmationMethod): string {
    return method === ConfirmationMethod.OTP
      ? String(randomInt(0, 1_000_000)).padStart(6, '0')
      : randomBytes(32).toString('base64url');
  }
}
