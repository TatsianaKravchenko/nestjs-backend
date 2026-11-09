import { HttpException, Injectable } from '@nestjs/common';
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
import { User, UserStatus } from '@/modules/users/entities/user.entity';
import { UsersService } from '@/modules/users/users.service';

import { AuthAuditService, RequestContext } from './auth-audit.service';
import {
  CHALLENGE_TTL_SECONDS,
  MAX_OTP_ATTEMPTS,
  RESEND_AFTER_SECONDS,
} from '../constants/auth.constants';
import {
  invalidConfirmation,
  invalidCredentials,
  loginDeliveryUnavailable,
  loginResendDeliveryUnavailable,
  loginResendTooSoon,
  loginResendUnavailable,
  rateLimitExceeded,
  serviceUnavailable,
} from '../errors/auth.errors';
import { ConfirmLoginDto } from '../dto/confirm-login.dto';
import { LoginDto } from '../dto/login.dto';
import { ResendLoginDto } from '../dto/resend-login.dto';
import {
  LoginAttempt,
  LoginAttemptConsumedReason,
} from '../entities/login-attempt.entity';
import { ConfirmationMethod } from '../entities/registration-attempt.entity';
import { LoginFailureLimiter } from './login-failure-limiter.service';
import { MailService } from './mail.service';
import { PasswordService } from './password.service';
import { TokenPair, TokenService } from './token.service';

export interface ChallengeResponse {
  confirmationRequired: true;
  method: ConfirmationMethod;
  attemptId: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

export interface ResendResponse {
  method: ConfirmationMethod;
  attemptId: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

export type LoginResult =
  | { kind: 'tokens'; tokens: TokenPair }
  | { kind: 'challenge'; body: ChallengeResponse };

type ChallengeOutcome =
  | { kind: 'created'; attempt: LoginAttempt }
  | { kind: 'throttled'; retryAfter: number }
  | { kind: 'inactive' };

type ConfirmOutcome =
  | { kind: 'ok'; userId: string; attemptId: string; tokens: TokenPair }
  | { kind: 'invalid' }
  | { kind: 'exhausted' }
  | { kind: 'inactive' };

type ResendOutcome =
  | { kind: 'sent'; attempt: LoginAttempt; email: string; secret: string }
  | { kind: 'invalid' }
  | { kind: 'exhausted' }
  | { kind: 'throttled'; retryAfter: number };

interface ParsedConfirm {
  attemptId: string;
  secret: string;
  method: ConfirmationMethod;
}

const LOCK = { mode: 'pessimistic_write' } as const;

@Injectable()
export class LoginService {
  private dummyHash?: Promise<string>;

  constructor(
    private readonly dataSource: DataSource,
    private readonly usersService: UsersService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly limiter: LoginFailureLimiter,
    private readonly audit: AuthAuditService,
  ) {}

  async login(dto: LoginDto, ctx: RequestContext): Promise<LoginResult> {
    const email = UsersService.normalizeEmail(dto.email);
    const subject = this.audit.pseudonym(email);
    const limiterKey = `${subject}|${ctx.ip}`;

    // Checked before the expensive hash comparison.
    if (this.limiter.isBlocked(limiterKey)) {
      this.audit.warn('login.rate_limited', {
        scope: 'email_ip',
        subject,
        requestId: ctx.requestId,
      });
      throw rateLimitExceeded();
    }

    const user = await this.db(ctx, () => this.usersService.findByEmail(email));
    // A missing user is verified against a dummy hash so timing does not reveal it.
    const passwordOk = await this.passwords
      .verify(user?.passwordHash ?? (await this.getDummyHash()), dto.password)
      .catch(() => false);

    if (!user || !passwordOk || user.status !== UserStatus.ACTIVE) {
      this.limiter.recordFailure(limiterKey);
      this.audit.warn('login.failed', {
        reason: !user
          ? 'unknown_user'
          : !passwordOk
            ? 'bad_password'
            : 'user_inactive',
        userId: user?.id,
        subject: user ? undefined : subject,
        requestId: ctx.requestId,
      });
      throw invalidCredentials();
    }
    this.limiter.reset(limiterKey);

    if (!this.confirmationEnabled()) {
      const tokens = await this.tokens.issuePair(user.id);
      this.audit.info('login.success', {
        userId: user.id,
        challenge: 'none',
        requestId: ctx.requestId,
      });
      return { kind: 'tokens', tokens };
    }

    return this.startChallenge(user, ctx);
  }

  async confirm(dto: ConfirmLoginDto, ctx: RequestContext): Promise<TokenPair> {
    const parsed = this.parseConfirm(dto);
    if (!parsed) {
      this.audit.warn('login.confirm.failed', {
        reason: 'malformed',
        requestId: ctx.requestId,
      });
      throw invalidConfirmation();
    }

    const outcome = await this.db(ctx, () =>
      this.dataSource.transaction((manager) => this.confirmIn(manager, parsed)),
    );

    switch (outcome.kind) {
      case 'ok':
        this.audit.info('login.confirm.success', {
          userId: outcome.userId,
          attemptId: outcome.attemptId,
          method: parsed.method,
          requestId: ctx.requestId,
        });
        return outcome.tokens;
      case 'exhausted':
        this.audit.warn('login.confirm.exhausted', {
          attemptId: parsed.attemptId,
          requestId: ctx.requestId,
        });
        throw rateLimitExceeded();
      case 'inactive':
        this.audit.warn('login.confirm.failed', {
          reason: 'user_inactive',
          attemptId: parsed.attemptId,
          requestId: ctx.requestId,
        });
        throw invalidCredentials();
      default:
        this.audit.warn('login.confirm.failed', {
          reason: 'invalid',
          attemptId: parsed.attemptId,
          requestId: ctx.requestId,
        });
        throw invalidConfirmation();
    }
  }

  async resend(
    dto: ResendLoginDto,
    ctx: RequestContext,
  ): Promise<ResendResponse> {
    const outcome = await this.db(ctx, () =>
      this.dataSource.transaction((manager) =>
        this.resendIn(manager, dto.attemptId),
      ),
    );

    if (outcome.kind === 'exhausted') {
      throw rateLimitExceeded();
    }
    if (outcome.kind === 'throttled') {
      this.audit.warn('login.resend.throttled', {
        attemptId: dto.attemptId,
        requestId: ctx.requestId,
      });
      throw this.tooSoon(outcome.retryAfter);
    }
    if (outcome.kind === 'invalid') {
      this.audit.warn('login.resend.failed', {
        attemptId: dto.attemptId,
        requestId: ctx.requestId,
      });
      throw loginResendUnavailable();
    }

    const { attempt } = outcome;
    this.audit.info('login.resend', {
      attemptId: attempt.id,
      method: attempt.method,
      requestId: ctx.requestId,
    });
    // The new hash stays stored even if delivery fails; the old secret is gone.
    try {
      await this.deliver(
        outcome.email,
        attempt.method,
        outcome.secret,
        attempt.id,
        ctx,
      );
    } catch {
      throw loginResendDeliveryUnavailable();
    }
    return {
      method: attempt.method,
      attemptId: attempt.id,
      expiresInSeconds: CHALLENGE_TTL_SECONDS,
      resendAfterSeconds: RESEND_AFTER_SECONDS,
    };
  }

  /* ------------------------------ login challenge ------------------------------ */

  private async startChallenge(
    user: User,
    ctx: RequestContext,
  ): Promise<LoginResult> {
    const method = this.confirmationMethod();
    const attemptId = randomUUID();
    const secret = this.generateSecret(method);

    const outcome = await this.db(ctx, () =>
      this.dataSource.transaction(
        async (manager): Promise<ChallengeOutcome> => {
          const locked = await manager.findOne(User, {
            where: { id: user.id },
            lock: LOCK,
          });
          if (!locked || locked.status !== UserStatus.ACTIVE) {
            return { kind: 'inactive' };
          }

          const previous = await manager.findOne(LoginAttempt, {
            where: { userId: user.id, consumedAt: IsNull() },
            lock: LOCK,
          });
          if (previous) {
            const retryAfter = this.retryAfter(previous.lastSentAt);
            if (retryAfter > 0) return { kind: 'throttled', retryAfter };
            this.consume(previous, LoginAttemptConsumedReason.REPLACED);
            await manager.save(previous);
          }

          const attempt = await manager.save(
            manager.create(LoginAttempt, {
              id: attemptId,
              userId: user.id,
              method,
              secretHash: this.hashSecret(attemptId, secret),
              attempts: 0,
              lastSentAt: new Date(),
              consumedAt: null,
              consumedReason: null,
            }),
          );
          return { kind: 'created', attempt };
        },
      ),
    );

    if (outcome.kind === 'inactive') {
      this.audit.warn('login.failed', {
        reason: 'user_inactive',
        userId: user.id,
        requestId: ctx.requestId,
      });
      throw invalidCredentials();
    }
    if (outcome.kind === 'throttled') {
      this.audit.warn('login.challenge.throttled', {
        userId: user.id,
        requestId: ctx.requestId,
      });
      throw this.tooSoon(outcome.retryAfter);
    }

    const { attempt } = outcome;
    this.audit.info('login.challenge.created', {
      userId: user.id,
      attemptId: attempt.id,
      method,
      requestId: ctx.requestId,
    });

    // The attempt is committed before SMTP is contacted.
    try {
      await this.deliver(user.email, method, secret, attempt.id, ctx);
    } catch {
      throw loginDeliveryUnavailable(
        method,
        attempt.id,
        this.retryAfter(attempt.lastSentAt),
      );
    }

    return {
      kind: 'challenge',
      body: {
        confirmationRequired: true,
        method,
        attemptId: attempt.id,
        expiresInSeconds: CHALLENGE_TTL_SECONDS,
        resendAfterSeconds: RESEND_AFTER_SECONDS,
      },
    };
  }

  /** Runs inside a transaction. Lock order is always user, then attempt. */
  private async confirmIn(
    manager: EntityManager,
    parsed: ParsedConfirm,
  ): Promise<ConfirmOutcome> {
    const peek = await manager.findOne(LoginAttempt, {
      where: { id: parsed.attemptId },
    });
    if (!peek) return { kind: 'invalid' };

    const user = await manager.findOne(User, {
      where: { id: peek.userId },
      lock: LOCK,
    });
    const attempt = await manager.findOne(LoginAttempt, {
      where: { id: parsed.attemptId },
      lock: LOCK,
    });
    if (!attempt) return { kind: 'invalid' };

    if (attempt.consumedAt) {
      return {
        kind:
          attempt.consumedReason ===
          LoginAttemptConsumedReason.ATTEMPTS_EXHAUSTED
            ? 'exhausted'
            : 'invalid',
      };
    }
    // An expired attempt does not touch the failure counter.
    if (this.isExpired(attempt)) return { kind: 'invalid' };

    if (!user || user.status !== UserStatus.ACTIVE) {
      this.consume(attempt, LoginAttemptConsumedReason.USER_INACTIVE);
      await manager.save(attempt);
      return { kind: 'inactive' };
    }

    // Submitting the wrong form for the attempt's method never counts as a guess.
    if (attempt.method !== parsed.method) return { kind: 'invalid' };

    const matches = this.safeEqual(
      this.hashSecret(attempt.id, parsed.secret),
      attempt.secretHash,
    );
    if (!matches) {
      // Only OTP codes are limited; a wrong link is just refused.
      if (attempt.method === ConfirmationMethod.OTP) {
        attempt.attempts += 1;
        if (attempt.attempts >= MAX_OTP_ATTEMPTS) {
          this.consume(attempt, LoginAttemptConsumedReason.ATTEMPTS_EXHAUSTED);
        }
        await manager.save(attempt);
      }
      return { kind: 'invalid' };
    }

    // Signed before the commit: a signing failure rolls back and the attempt stays usable.
    const tokens = await this.tokens.issuePair(user.id);
    this.consume(attempt, LoginAttemptConsumedReason.CONFIRMED);
    await manager.save(attempt);
    return { kind: 'ok', userId: user.id, attemptId: attempt.id, tokens };
  }

  private async resendIn(
    manager: EntityManager,
    attemptId: string,
  ): Promise<ResendOutcome> {
    const peek = await manager.findOne(LoginAttempt, {
      where: { id: attemptId },
    });
    if (!peek) return { kind: 'invalid' };

    const user = await manager.findOne(User, {
      where: { id: peek.userId },
      lock: LOCK,
    });
    const attempt = await manager.findOne(LoginAttempt, {
      where: { id: attemptId },
      lock: LOCK,
    });
    if (!attempt) return { kind: 'invalid' };

    if (attempt.consumedAt) {
      return {
        kind:
          attempt.consumedReason ===
          LoginAttemptConsumedReason.ATTEMPTS_EXHAUSTED
            ? 'exhausted'
            : 'invalid',
      };
    }
    if (!user || user.status !== UserStatus.ACTIVE) {
      this.consume(attempt, LoginAttemptConsumedReason.USER_INACTIVE);
      await manager.save(attempt);
      return { kind: 'invalid' };
    }

    const retryAfter = this.retryAfter(attempt.lastSentAt);
    if (retryAfter > 0) return { kind: 'throttled', retryAfter };

    const secret = this.generateSecret(attempt.method);
    attempt.secretHash = this.hashSecret(attempt.id, secret);
    attempt.lastSentAt = new Date();
    attempt.attempts = 0;
    await manager.save(attempt);
    return { kind: 'sent', attempt, email: user.email, secret };
  }

  /* --------------------------------- helpers ---------------------------------- */

  /** Sends the secret by email. The secret never reaches a log or a response. */
  private async deliver(
    email: string,
    method: ConfirmationMethod,
    secret: string,
    attemptId: string,
    ctx: RequestContext,
  ): Promise<void> {
    try {
      if (method === ConfirmationMethod.OTP) {
        await this.mail.sendLoginOtp(email, secret);
      } else {
        // The token travels in the fragment, so it is never sent to a server by a GET.
        const url = new URL(this.config.get('LOGIN_MAGIC_LINK_URL'));
        url.hash = `token=${attemptId}.${secret}`;
        await this.mail.sendLoginMagicLink(email, url.toString());
      }
      this.audit.info('login.challenge.sent', {
        attemptId,
        method,
        requestId: ctx.requestId,
      });
    } catch (error) {
      this.audit.error('login.challenge.delivery_unavailable', {
        attemptId,
        method,
        requestId: ctx.requestId,
      });
      throw error;
    }
  }

  /** Database trouble is a 503 (retryable), never a 401 or a leaked 500. */
  private async db<T>(ctx: RequestContext, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.audit.error('auth.database_unavailable', {
        requestId: ctx.requestId,
      });
      throw serviceUnavailable();
    }
  }

  private parseConfirm(dto: ConfirmLoginDto): ParsedConfirm | null {
    if (dto.token !== undefined) {
      if (dto.attemptId !== undefined || dto.code !== undefined) return null;
      const separator = dto.token.indexOf('.');
      const attemptId = dto.token.slice(0, separator);
      const secret = dto.token.slice(separator + 1);
      if (
        separator < 0 ||
        !isUUID(attemptId) ||
        !/^[A-Za-z0-9_-]{43}$/.test(secret)
      ) {
        return null;
      }
      return { attemptId, secret, method: ConfirmationMethod.MAGIC_LINK };
    }
    if (dto.attemptId !== undefined && dto.code !== undefined) {
      return {
        attemptId: dto.attemptId,
        secret: dto.code,
        method: ConfirmationMethod.OTP,
      };
    }
    return null;
  }

  private consume(
    attempt: LoginAttempt,
    reason: LoginAttemptConsumedReason,
  ): void {
    attempt.consumedAt = new Date();
    attempt.consumedReason = reason;
  }

  private isExpired(attempt: LoginAttempt): boolean {
    return (
      attempt.lastSentAt.getTime() + CHALLENGE_TTL_SECONDS * 1000 <= Date.now()
    );
  }

  /** Whole seconds left of the pause since the last email; 0 when it is over. */
  private retryAfter(lastSentAt: Date): number {
    const remaining =
      lastSentAt.getTime() + RESEND_AFTER_SECONDS * 1000 - Date.now();
    return Math.max(0, Math.ceil(remaining / 1000));
  }

  private tooSoon(retryAfterSeconds: number): HttpException {
    return loginResendTooSoon(retryAfterSeconds);
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.passwords.hash(randomBytes(16).toString('hex'));
    return this.dummyHash;
  }

  private confirmationEnabled(): boolean {
    return (
      String(this.config.get('LOGIN_EMAIL_CONFIRMATION_ENABLED')) === 'true'
    );
  }

  private confirmationMethod(): ConfirmationMethod {
    return String(this.config.get('LOGIN_EMAIL_CONFIRMATION_METHOD')) ===
      'magic_link'
      ? ConfirmationMethod.MAGIC_LINK
      : ConfirmationMethod.OTP;
  }

  private generateSecret(method: ConfirmationMethod): string {
    return method === ConfirmationMethod.OTP
      ? String(randomInt(0, 1_000_000)).padStart(6, '0')
      : randomBytes(32).toString('base64url');
  }

  /** HMAC-SHA256 under its own key; the secret is bound to its attempt id. */
  private hashSecret(attemptId: string, secret: string): string {
    return createHmac('sha256', this.config.get('LOGIN_CHALLENGE_HMAC_KEY'))
      .update(`${attemptId}:${secret}`)
      .digest('hex');
  }

  private safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
