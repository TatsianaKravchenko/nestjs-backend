import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'crypto';
import { DataSource, LessThanOrEqual, Repository } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import { User, UserStatus } from '@/modules/users/entities/user.entity';
import { UsersService } from '@/modules/users/users.service';

import { ConfirmRegistrationDto } from './dto/confirm-registration.dto';
import { RegisterDto } from './dto/register.dto';
import { ResendRegistrationDto } from './dto/resend-registration.dto';
import {
  ConfirmationMethod,
  RegistrationAttempt,
} from './entities/registration-attempt.entity';
import { MailService } from './mail.service';
import { PasswordService } from './password.service';

export const CONFIRMATION_TTL_SECONDS = 600;
export const RESEND_AFTER_SECONDS = 60;
export const MAX_OTP_FAILURES = 5;

const PG_UNIQUE_VIOLATION = '23505';

export interface RegisteredUserResponse {
  id: string;
  email: string;
  status: UserStatus;
}

export interface ConfirmationRequiredResponse {
  confirmationRequired: true;
  method: ConfirmationMethod;
  attemptId: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

export type RegisterResult =
  | { statusCode: HttpStatus.CREATED; body: RegisteredUserResponse }
  | { statusCode: HttpStatus.ACCEPTED; body: ConfirmationRequiredResponse };

type ConfirmOutcome = 'ok' | 'invalid' | 'exhausted';

const INVALID_CONFIRMATION = 'Invalid or expired confirmation';

@Injectable()
export class RegistrationService {
  private readonly logger = new Logger(RegistrationService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(RegistrationAttempt)
    private readonly attempts: Repository<RegistrationAttempt>,
    private readonly usersService: UsersService,
    private readonly passwords: PasswordService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  async register(dto: RegisterDto): Promise<RegisterResult> {
    const email = UsersService.normalizeEmail(dto.email);

    if (await this.usersService.findByEmail(email)) {
      this.logger.warn('Registration rejected: email already registered');
      throw new ConflictException('Email is already registered');
    }

    const passwordHash = await this.passwords.hash(dto.password);

    if (!this.confirmationEnabled()) {
      const user = await this.insertUser(
        email,
        passwordHash,
        UserStatus.ACTIVE,
      );
      this.logger.log(`User registered userId=${user.id}`);
      return {
        statusCode: HttpStatus.CREATED,
        body: { id: user.id, email: user.email, status: user.status },
      };
    }

    const method = this.confirmationMethod();
    const attemptId = randomUUID();
    const secret = this.generateSecret(method);

    const { user, attempt } = await this.dataSource
      .transaction(async (manager) => {
        const created = await manager.save(
          manager.create(User, {
            email,
            passwordHash,
            status: UserStatus.PENDING,
          }),
        );
        const savedAttempt = await manager.save(
          manager.create(RegistrationAttempt, {
            id: attemptId,
            userId: created.id,
            method,
            secretHash: this.hashSecret(method, attemptId, secret),
            expiresAt: this.expiry(),
            failedAttempts: 0,
            consumedAt: null,
            lastSentAt: new Date(),
          }),
        );
        return { user: created, attempt: savedAttempt };
      })
      .catch((error: unknown) => this.rethrowDuplicate(error));

    this.logger.log(
      `Pending user registered userId=${user.id} attemptId=${attempt.id} method=${method}`,
    );
    await this.deliver(email, method, secret, attempt.id);

    return {
      statusCode: HttpStatus.ACCEPTED,
      body: this.confirmationResponse(attempt),
    };
  }

  async confirm(dto: ConfirmRegistrationDto): Promise<RegisteredUserResponse> {
    const outcome = await this.dataSource.transaction(
      async (manager): Promise<{ outcome: ConfirmOutcome; user?: User }> => {
        const attempt = await this.findAttemptForConfirm(manager, dto);
        if (!attempt || attempt.consumedAt) {
          return { outcome: 'invalid' };
        }

        const user = await manager.findOne(User, {
          where: { id: attempt.userId },
        });
        if (!user || user.status !== UserStatus.PENDING) {
          return { outcome: 'invalid' };
        }

        // Expired attempts are rejected without touching the failure counter.
        if (attempt.expiresAt.getTime() <= Date.now()) {
          return { outcome: 'invalid' };
        }

        if (attempt.method === ConfirmationMethod.OTP) {
          const candidate = this.hashSecret(
            ConfirmationMethod.OTP,
            attempt.id,
            dto.code ?? '',
          );
          if (!this.safeEqual(candidate, attempt.secretHash)) {
            attempt.failedAttempts += 1;
            const exhausted = attempt.failedAttempts >= MAX_OTP_FAILURES;
            if (exhausted) {
              attempt.consumedAt = new Date();
            }
            await manager.save(attempt);
            return { outcome: exhausted ? 'exhausted' : 'invalid' };
          }
        }

        attempt.consumedAt = new Date();
        user.status = UserStatus.ACTIVE;
        await manager.save(attempt);
        await manager.save(user);
        return { outcome: 'ok', user };
      },
    );

    if (outcome.outcome === 'exhausted') {
      this.logger.warn('Registration confirmation: attempts exhausted');
      throw new HttpException(
        'Too many failed attempts. Request a new code.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (outcome.outcome === 'invalid' || !outcome.user) {
      this.logger.warn('Registration confirmation failed');
      throw new BadRequestException(INVALID_CONFIRMATION);
    }

    this.logger.log(`Registration confirmed userId=${outcome.user.id}`);
    return {
      id: outcome.user.id,
      email: outcome.user.email,
      status: outcome.user.status,
    };
  }

  async resend(
    dto: ResendRegistrationDto,
  ): Promise<ConfirmationRequiredResponse> {
    const user = await this.usersService.findByEmail(dto.email);
    const attempt =
      user && user.status === UserStatus.PENDING
        ? await this.attempts.findOne({
            where: { userId: user.id },
            order: { createdAt: 'DESC' },
          })
        : null;

    if (!user || !attempt) {
      throw new BadRequestException('Registration cannot be resent');
    }

    const now = new Date();
    const secret = this.generateSecret(attempt.method);
    const expiresAt = this.expiry();

    // Conditional update makes the 60s limit race-free.
    const result = await this.attempts.update(
      {
        id: attempt.id,
        lastSentAt: LessThanOrEqual(
          new Date(now.getTime() - RESEND_AFTER_SECONDS * 1000),
        ),
      },
      {
        secretHash: this.hashSecret(attempt.method, attempt.id, secret),
        expiresAt,
        failedAttempts: 0,
        consumedAt: null,
        lastSentAt: now,
      },
    );

    if (!result.affected) {
      this.logger.warn(`Resend throttled attemptId=${attempt.id}`);
      throw new HttpException(
        `Resend is allowed once per ${RESEND_AFTER_SECONDS} seconds`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    await this.deliver(user.email, attempt.method, secret, attempt.id);

    return this.confirmationResponse(attempt);
  }

  private async insertUser(
    email: string,
    passwordHash: string,
    status: UserStatus,
  ): Promise<User> {
    try {
      return await this.users.save(
        this.users.create({ email, passwordHash, status }),
      );
    } catch (error) {
      return this.rethrowDuplicate(error);
    }
  }

  /** A unique-constraint race maps to the regular duplicate error. */
  private rethrowDuplicate(error: unknown): never {
    const code = (error as { driverError?: { code?: string } })?.driverError
      ?.code;
    if (code === PG_UNIQUE_VIOLATION) {
      this.logger.warn('Registration rejected: unique constraint on email');
      throw new ConflictException('Email is already registered');
    }
    throw error;
  }

  private findAttemptForConfirm(
    manager: DataSource['manager'],
    dto: ConfirmRegistrationDto,
  ): Promise<RegistrationAttempt | null> {
    const lock = { mode: 'pessimistic_write' } as const;
    if (dto.token) {
      return manager.findOne(RegistrationAttempt, {
        where: {
          method: ConfirmationMethod.MAGIC_LINK,
          secretHash: this.hashSecret(
            ConfirmationMethod.MAGIC_LINK,
            '',
            dto.token,
          ),
        },
        lock,
      });
    }
    if (dto.attemptId && dto.code) {
      return manager.findOne(RegistrationAttempt, {
        where: { id: dto.attemptId, method: ConfirmationMethod.OTP },
        lock,
      });
    }
    return Promise.resolve(null);
  }

  /** Sends the secret; a delivery failure keeps the pending user and attempt (503). */
  private async deliver(
    email: string,
    method: ConfirmationMethod,
    secret: string,
    attemptId: string,
  ): Promise<void> {
    try {
      if (method === ConfirmationMethod.OTP) {
        await this.mail.sendRegistrationOtp(email, secret);
      } else {
        const url = new URL(this.config.get('REGISTRATION_MAGIC_LINK_URL'));
        url.searchParams.set('token', secret);
        await this.mail.sendRegistrationMagicLink(email, url.toString());
      }
      this.logger.log(
        `Confirmation sent attemptId=${attemptId} method=${method}`,
      );
    } catch (error) {
      this.logger.error(
        `Confirmation delivery failed attemptId=${attemptId}: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'Could not send the confirmation email. Use resend to try again.',
      );
    }
  }

  private confirmationResponse(
    attempt: RegistrationAttempt,
  ): ConfirmationRequiredResponse {
    return {
      confirmationRequired: true,
      method: attempt.method,
      attemptId: attempt.id,
      expiresInSeconds: CONFIRMATION_TTL_SECONDS,
      resendAfterSeconds: RESEND_AFTER_SECONDS,
    };
  }

  private confirmationEnabled(): boolean {
    return (
      String(this.config.get('REGISTRATION_CONFIRMATION_ENABLED')) === 'true'
    );
  }

  private confirmationMethod(): ConfirmationMethod {
    return String(this.config.get('REGISTRATION_CONFIRMATION_METHOD')) ===
      'magic_link'
      ? ConfirmationMethod.MAGIC_LINK
      : ConfirmationMethod.OTP;
  }

  private expiry(): Date {
    return new Date(Date.now() + CONFIRMATION_TTL_SECONDS * 1000);
  }

  private generateSecret(method: ConfirmationMethod): string {
    return method === ConfirmationMethod.OTP
      ? String(randomInt(0, 1_000_000)).padStart(6, '0')
      : randomBytes(32).toString('base64url');
  }

  /** HMAC of the secret; OTP codes are additionally bound to their attempt id. */
  private hashSecret(
    method: ConfirmationMethod,
    attemptId: string,
    secret: string,
  ): string {
    const input =
      method === ConfirmationMethod.OTP ? `${attemptId}:${secret}` : secret;
    return createHmac('sha256', this.config.get('REGISTRATION_SECRET'))
      .update(input)
      .digest('hex');
  }

  private safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
