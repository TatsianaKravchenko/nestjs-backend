/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call */
import {
  BadRequestException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';
import { User, UserStatus } from '@/modules/users/entities/user.entity';
import { UsersService } from '@/modules/users/users.service';

import { AuthAuditService } from './auth-audit.service';
import {
  LoginAttempt,
  LoginAttemptConsumedReason,
} from '../entities/login-attempt.entity';
import { ConfirmationMethod } from '../entities/registration-attempt.entity';
import { LoginFailureLimiter } from './login-failure-limiter.service';
import { LoginService } from './login.service';
import { MailService } from './mail.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

const PASSWORD = 'Passw0rd-unit';
const ctx = { ip: '1.1.1.1', requestId: 'req-1' };

type Row = Record<string, any>;

function build(settings: Record<string, string> = {}) {
  const values: Record<string, string> = {
    LOGIN_EMAIL_CONFIRMATION_ENABLED: 'true',
    LOGIN_EMAIL_CONFIRMATION_METHOD: 'otp',
    LOGIN_CHALLENGE_HMAC_KEY: 'h'.repeat(40),
    LOGIN_MAGIC_LINK_URL: 'http://app.test/auth/login/confirm',
    LOGIN_FAILURE_LIMIT: '5',
    LOGIN_FAILURE_WINDOW_MS: '900000',
    ...settings,
  };
  const config = { get: (key: string) => values[key] };

  const user: Row = {
    id: 'user-1',
    email: 'a@b.co',
    passwordHash: `hash:${PASSWORD}`,
    status: UserStatus.ACTIVE,
  };
  const users = new Map<string, Row>([[user.id, user]]);
  const attempts = new Map<string, Row>();

  const manager = {
    create: jest.fn((_entity: unknown, data: Row) => ({ ...data })),
    save: jest.fn((entity: Row) => {
      if (entity.secretHash) attempts.set(entity.id, entity);
      return Promise.resolve(entity);
    }),
    findOne: jest.fn(
      (entity: unknown, options: { where: Row; lock?: { mode: string } }) => {
        const { where } = options;
        if (entity === User)
          return Promise.resolve(users.get(where.id) ?? null);
        if (entity === LoginAttempt) {
          if (where.id) return Promise.resolve(attempts.get(where.id) ?? null);
          const open = [...attempts.values()].find(
            (a) => a.userId === where.userId && a.consumedAt === null,
          );
          return Promise.resolve(open ?? null);
        }
        return Promise.resolve(null);
      },
    ),
  };
  const dataSource = {
    transaction: jest.fn(
      (work: (m: unknown) => unknown): Promise<unknown> =>
        Promise.resolve(work(manager)),
    ),
  };

  const usersService = {
    findByEmail: jest.fn((email: string) =>
      Promise.resolve(email === user.email ? user : null),
    ),
  };
  const passwords = {
    verify: jest.fn((hash: string, password: string) =>
      Promise.resolve(hash === `hash:${password}`),
    ),
    hash: jest.fn().mockResolvedValue('hash:dummy-never-matches'),
  };
  const tokens = {
    issuePair: jest.fn().mockResolvedValue({ access: 'acc', refresh: 'ref' }),
  };
  const mail = {
    sendLoginOtp: jest.fn().mockResolvedValue(undefined),
    sendLoginMagicLink: jest.fn().mockResolvedValue(undefined),
  };
  const audit = {
    pseudonym: jest.fn((email: string) => `ps-${email}`),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const limiter = new LoginFailureLimiter(config as unknown as ConfigService);

  const service = new LoginService(
    dataSource as never,
    usersService as unknown as UsersService,
    passwords as unknown as PasswordService,
    tokens as unknown as TokenService,
    mail as unknown as MailService,
    config as unknown as ConfigService,
    limiter,
    audit as unknown as AuthAuditService,
  );
  return {
    service,
    values,
    user,
    users,
    attempts,
    manager,
    dataSource,
    usersService,
    passwords,
    tokens,
    mail,
    audit,
    limiter,
  };
}
type Harness = ReturnType<typeof build>;

const credentials = (email = 'a@b.co', password = PASSWORD) => ({
  email,
  password,
});

async function failure(promise: Promise<unknown>): Promise<any> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

const statusOf = (error: unknown) => (error as HttpException).getStatus();
const bodyOf = (error: unknown) => (error as HttpException).getResponse();

/** Logs in with OTP and returns the attempt and the emailed code. */
async function otpLogin(settings: Record<string, string> = {}) {
  const h = build(settings);
  const result = await h.service.login(credentials(), ctx);
  if (result.kind !== 'challenge') throw new Error('expected a challenge');
  const attemptId = result.body.attemptId;
  const code: string = h.mail.sendLoginOtp.mock.calls[0][1];
  return { h, attemptId, code, attempt: h.attempts.get(attemptId)! };
}

async function magicLogin() {
  const h = build({ LOGIN_EMAIL_CONFIRMATION_METHOD: 'magic_link' });
  const result = await h.service.login(credentials(), ctx);
  if (result.kind !== 'challenge') throw new Error('expected a challenge');
  const link = new URL(h.mail.sendLoginMagicLink.mock.calls[0][1]);
  const token = new URLSearchParams(link.hash.slice(1)).get('token')!;
  return { h, attemptId: result.body.attemptId, token, link };
}

const wrongCode = (code: string) => (code === '000000' ? '000001' : '000000');
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);

describe('LoginService.login', () => {
  describe('without email confirmation', () => {
    const direct = () => build({ LOGIN_EMAIL_CONFIRMATION_ENABLED: 'false' });

    it('signs both tokens for an active user and sends no email', async () => {
      const h = direct();

      const result = await h.service.login(credentials(), ctx);

      expect(result).toEqual({
        kind: 'tokens',
        tokens: { access: 'acc', refresh: 'ref' },
      });
      expect(h.tokens.issuePair).toHaveBeenCalledWith('user-1');
      expect(h.dataSource.transaction).not.toHaveBeenCalled();
      expect(h.mail.sendLoginOtp).not.toHaveBeenCalled();
    });

    it('normalizes the email but keeps the password as typed', async () => {
      const h = direct();
      h.user.passwordHash = 'hash: padded pass 1 ';

      await expect(
        h.service.login(credentials('  A@B.CO ', ' padded pass 1 '), ctx),
      ).resolves.toMatchObject({ kind: 'tokens' });
      await expect(
        h.service.login(credentials('a@b.co', 'padded pass 1'), ctx),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('does not sign anything when signing fails (503)', async () => {
      const h = direct();
      h.tokens.issuePair.mockRejectedValue(new ServiceUnavailableException());

      await expect(h.service.login(credentials(), ctx)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe('refusals', () => {
    const inactive = (status: string) => (h: Harness) => {
      h.user.status = status;
      return h.service.login(credentials(), ctx);
    };

    it.each([
      [
        'an unknown email',
        (h: Harness) => h.service.login(credentials('x@y.zz'), ctx),
      ],
      [
        'a wrong password',
        (h: Harness) => h.service.login(credentials('a@b.co', 'nope'), ctx),
      ],
      ['a pending user', inactive('pending')],
      ['a blocked user', inactive('blocked')],
      ['a deleting user', inactive('deleting')],
      ['a deleted user', inactive('deleted')],
    ])('answers the one neutral 401 for %s', async (_name, attempt) => {
      const error = await failure(attempt(build()));

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(bodyOf(error)).toEqual({
        statusCode: 401,
        code: 'invalid_credentials',
        message: 'Invalid credentials',
      });
    });

    it('never starts a challenge or sends mail on a refusal', async () => {
      const h = build();

      await failure(inactive('blocked')(h));

      expect(h.dataSource.transaction).not.toHaveBeenCalled();
      expect(h.mail.sendLoginOtp).not.toHaveBeenCalled();
    });

    it('verifies against a dummy hash when the user is unknown', async () => {
      const h = build();

      await failure(h.service.login(credentials('x@y.zz'), ctx));

      expect(h.passwords.verify).toHaveBeenCalledTimes(1);
      expect(h.passwords.verify.mock.calls[0][0]).toBe(
        'hash:dummy-never-matches',
      );
      expect(h.passwords.hash).toHaveBeenCalledTimes(1);
    });

    it('logs the reason internally but only a pseudonym for an unknown email', async () => {
      const h = build();

      await failure(h.service.login(credentials('x@y.zz'), ctx));

      expect(h.audit.warn).toHaveBeenCalledWith('login.failed', {
        reason: 'unknown_user',
        userId: undefined,
        subject: 'ps-x@y.zz',
        requestId: 'req-1',
      });
      expect(JSON.stringify(h.audit.warn.mock.calls)).not.toContain(PASSWORD);
    });

    it('blocks an email and IP pair after 5 failed checks, before hashing', async () => {
      const h = build();
      for (let i = 0; i < 5; i++) {
        await failure(h.service.login(credentials('a@b.co', 'nope'), ctx));
      }
      h.passwords.verify.mockClear();

      const error = await failure(h.service.login(credentials(), ctx));

      expect(statusOf(error)).toBe(429);
      expect(h.passwords.verify).not.toHaveBeenCalled();
    });

    it('does not block the same email from another IP, or another email', async () => {
      const h = build();
      for (let i = 0; i < 5; i++) {
        await failure(h.service.login(credentials('a@b.co', 'nope'), ctx));
      }

      await expect(
        h.service.login(credentials(), { ...ctx, ip: '2.2.2.2' }),
      ).resolves.toMatchObject({ kind: 'challenge' });
    });

    it('answers 503 when the database is unavailable', async () => {
      const h = build();
      h.usersService.findByEmail.mockRejectedValue(new Error('down'));

      await expect(h.service.login(credentials(), ctx)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe('with an OTP challenge', () => {
    it('answers 202 data without the code and stores only its hash', async () => {
      const { h, attemptId, code, attempt } = await otpLogin();

      expect(h.mail.sendLoginOtp).toHaveBeenCalledWith('a@b.co', code);
      expect(code).toMatch(/^\d{6}$/);
      expect(attempt).toMatchObject({
        userId: 'user-1',
        method: ConfirmationMethod.OTP,
        attempts: 0,
        consumedAt: null,
      });
      expect(attempt.secretHash).toMatch(/^[0-9a-f]{64}$/);
      expect(attempt.secretHash).not.toContain(code);
      expect(attemptId).toBe(attempt.id);
      expect(h.tokens.issuePair).not.toHaveBeenCalled();
    });

    it('returns the challenge shape and no secret', async () => {
      const h = build();

      const result = await h.service.login(credentials(), ctx);

      expect(result).toEqual({
        kind: 'challenge',
        body: {
          confirmationRequired: true,
          method: 'otp',
          attemptId: expect.any(String),
          expiresInSeconds: 600,
          resendAfterSeconds: 60,
        },
      });
      expect(JSON.stringify(result)).not.toMatch(/code|secret|token|hash/i);
    });

    it('answers 429 with the remaining time inside the 60 second pause', async () => {
      const { h, attemptId, attempt } = await otpLogin();
      attempt.lastSentAt = ago(45);
      h.mail.sendLoginOtp.mockClear();

      const error = await failure(h.service.login(credentials(), ctx));

      expect(statusOf(error)).toBe(429);
      expect((bodyOf(error) as Row).retryAfterSeconds).toBeGreaterThan(10);
      expect((bodyOf(error) as Row).retryAfterSeconds).toBeLessThanOrEqual(15);
      expect(h.mail.sendLoginOtp).not.toHaveBeenCalled();
      expect(attempt.consumedAt).toBeNull();
      expect(h.attempts.size).toBe(1);
      expect(h.attempts.has(attemptId)).toBe(true);
    });

    it('replaces the previous attempt after the pause', async () => {
      const { h, attemptId, code, attempt } = await otpLogin();
      attempt.lastSentAt = ago(61);

      const second = await h.service.login(credentials(), ctx);

      expect(attempt.consumedReason).toBe(LoginAttemptConsumedReason.REPLACED);
      expect(attempt.consumedAt).toBeInstanceOf(Date);
      expect(second).toMatchObject({ kind: 'challenge' });
      if (second.kind === 'challenge') {
        expect(second.body.attemptId).not.toBe(attemptId);
      }
      // The replaced code no longer works.
      await expect(
        h.service.confirm({ attemptId, code }, ctx),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('answers 401 without email when the user became inactive during the attempt', async () => {
      const h = build();
      // The user is active when the password is checked and locked as inactive afterwards.
      h.manager.findOne.mockImplementationOnce(() =>
        Promise.resolve({ ...h.user, status: UserStatus.PENDING }),
      );

      const error = await failure(h.service.login(credentials(), ctx));

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(h.mail.sendLoginOtp).not.toHaveBeenCalled();
      expect(h.attempts.size).toBe(0);
    });

    it('commits the attempt, then answers 503 with retry data when SMTP rejects', async () => {
      const h = build();
      h.mail.sendLoginOtp.mockRejectedValue(new Error('smtp down'));

      const error = await failure(h.service.login(credentials(), ctx));

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      const [attempt] = [...h.attempts.values()];
      expect(h.attempts.size).toBe(1);
      expect(bodyOf(error)).toMatchObject({
        statusCode: 503,
        confirmationRequired: true,
        method: 'otp',
        attemptId: attempt.id,
        retryAfterSeconds: expect.any(Number),
      });
      expect((bodyOf(error) as Row).retryAfterSeconds).toBeGreaterThan(55);
      expect(JSON.stringify(bodyOf(error))).not.toContain(
        h.mail.sendLoginOtp.mock.calls[0][1],
      );
    });

    it('sends no email and answers 503 when the attempt cannot be committed', async () => {
      const h = build();
      h.dataSource.transaction.mockRejectedValue(new Error('commit failed'));

      await expect(h.service.login(credentials(), ctx)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(h.mail.sendLoginOtp).not.toHaveBeenCalled();
    });

    it('locks the user before the attempt', async () => {
      const h = build();

      await h.service.login(credentials(), ctx);

      const entities = h.manager.findOne.mock.calls.map((c) => c[0]);
      expect(entities).toEqual([User, LoginAttempt]);
      expect(h.manager.findOne.mock.calls[0][1].lock).toEqual({
        mode: 'pessimistic_write',
      });
    });
  });

  describe('with a magic link challenge', () => {
    it('puts attemptId.secret in the URL fragment, never in the query', async () => {
      const { h, attemptId, token, link } = await magicLogin();

      expect(link.origin + link.pathname).toBe(
        'http://app.test/auth/login/confirm',
      );
      expect(link.search).toBe('');
      const [id, secret] = token.split('.');
      expect(id).toBe(attemptId);
      expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
      expect(h.attempts.get(attemptId)!.secretHash).not.toContain(secret);
      expect(h.mail.sendLoginOtp).not.toHaveBeenCalled();
    });
  });
});

describe('LoginService.confirm', () => {
  describe('OTP', () => {
    it('signs the tokens and consumes the attempt with a correct code', async () => {
      const { h, attemptId, code, attempt } = await otpLogin();

      await expect(
        h.service.confirm({ attemptId, code }, ctx),
      ).resolves.toEqual({ access: 'acc', refresh: 'ref' });

      expect(attempt.consumedReason).toBe(LoginAttemptConsumedReason.CONFIRMED);
      expect(attempt.consumedAt).toBeInstanceOf(Date);
    });

    it('does not accept the same code twice', async () => {
      const { h, attemptId, code } = await otpLogin();
      await h.service.confirm({ attemptId, code }, ctx);

      await expect(
        h.service.confirm({ attemptId, code }, ctx),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('counts wrong codes and still accepts the correct fifth entry', async () => {
      const { h, attemptId, code, attempt } = await otpLogin();

      for (let i = 0; i < 4; i++) {
        await expect(
          h.service.confirm({ attemptId, code: wrongCode(code) }, ctx),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(attempt.attempts).toBe(4);

      await expect(
        h.service.confirm({ attemptId, code }, ctx),
      ).resolves.toMatchObject({ access: 'acc' });
    });

    it('answers 400 on the fifth wrong code, burns the attempt, then 429', async () => {
      const { h, attemptId, code, attempt } = await otpLogin();
      const statuses: number[] = [];

      for (let i = 0; i < 5; i++) {
        const error = await failure(
          h.service.confirm({ attemptId, code: wrongCode(code) }, ctx),
        );
        statuses.push(statusOf(error));
      }

      expect(statuses).toEqual([400, 400, 400, 400, 400]);
      expect(attempt.consumedReason).toBe(
        LoginAttemptConsumedReason.ATTEMPTS_EXHAUSTED,
      );

      // Even the correct code is now refused, with 429.
      const next = await failure(h.service.confirm({ attemptId, code }, ctx));
      expect(statusOf(next)).toBe(429);
      expect(h.tokens.issuePair).not.toHaveBeenCalled();
    });

    it('rejects an expired attempt without touching the counter', async () => {
      const { h, attemptId, code, attempt } = await otpLogin();
      attempt.lastSentAt = ago(601);

      const error = await failure(
        h.service.confirm({ attemptId, code: wrongCode(code) }, ctx),
      );

      expect(statusOf(error)).toBe(400);
      expect(attempt.attempts).toBe(0);
      expect(attempt.consumedAt).toBeNull();
    });

    it('answers unknown, wrong and replaced attempts with the same 400 body', async () => {
      const { h, attemptId, code } = await otpLogin();

      const wrong = await failure(
        h.service.confirm({ attemptId, code: wrongCode(code) }, ctx),
      );
      const unknown = await failure(
        h.service.confirm(
          { attemptId: '0b8b6f4e-6a53-4b0c-9a51-0d3d7a4c9f10', code },
          ctx,
        ),
      );

      expect(statusOf(wrong)).toBe(400);
      expect(statusOf(unknown)).toBe(400);
      expect(bodyOf(unknown)).toEqual(bodyOf(wrong));
    });

    it('refuses with the neutral 401 and consumes the attempt when the user became inactive', async () => {
      const { h, attemptId, code, attempt } = await otpLogin();
      h.user.status = UserStatus.PENDING;

      const error = await failure(h.service.confirm({ attemptId, code }, ctx));

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(bodyOf(error)).toMatchObject({ code: 'invalid_credentials' });
      expect(attempt.consumedReason).toBe(
        LoginAttemptConsumedReason.USER_INACTIVE,
      );
      expect(h.tokens.issuePair).not.toHaveBeenCalled();
    });

    it('does not count a link token submitted for an OTP attempt', async () => {
      const { h, attemptId, attempt } = await otpLogin();
      const token = `${attemptId}.${'A'.repeat(43)}`;

      const error = await failure(h.service.confirm({ token }, ctx));

      expect(statusOf(error)).toBe(400);
      expect(attempt.attempts).toBe(0);
    });

    it('keeps the attempt usable when signing fails (503)', async () => {
      const { h, attemptId, code, attempt } = await otpLogin();
      h.tokens.issuePair.mockRejectedValueOnce(
        new ServiceUnavailableException(),
      );

      await expect(
        h.service.confirm({ attemptId, code }, ctx),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(attempt.consumedAt).toBeNull();

      await expect(
        h.service.confirm({ attemptId, code }, ctx),
      ).resolves.toMatchObject({ access: 'acc' });
    });

    it('answers 503 when the transaction cannot commit', async () => {
      const { h, attemptId, code } = await otpLogin();
      h.dataSource.transaction.mockRejectedValueOnce(
        new Error('commit failed'),
      );

      await expect(
        h.service.confirm({ attemptId, code }, ctx),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('locks the user, then the attempt', async () => {
      const { h, attemptId, code } = await otpLogin();
      h.manager.findOne.mockClear();

      await h.service.confirm({ attemptId, code }, ctx);

      const calls = h.manager.findOne.mock.calls;
      expect(calls.map((c) => c[0])).toEqual([
        LoginAttempt,
        User,
        LoginAttempt,
      ]);
      expect(calls[0][1].lock).toBeUndefined();
      expect(calls[1][1].lock).toEqual({ mode: 'pessimistic_write' });
      expect(calls[2][1].lock).toEqual({ mode: 'pessimistic_write' });
    });
  });

  describe('magic link', () => {
    it('signs the tokens once and consumes the attempt', async () => {
      const { h, attemptId, token } = await magicLogin();

      await expect(h.service.confirm({ token }, ctx)).resolves.toEqual({
        access: 'acc',
        refresh: 'ref',
      });
      expect(h.attempts.get(attemptId)!.consumedReason).toBe(
        LoginAttemptConsumedReason.CONFIRMED,
      );
      await expect(h.service.confirm({ token }, ctx)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('answers 400 for a wrong secret and never counts it', async () => {
      const { h, attemptId } = await magicLogin();
      const attempt = h.attempts.get(attemptId)!;

      for (let i = 0; i < 6; i++) {
        const error = await failure(
          h.service.confirm({ token: `${attemptId}.${'A'.repeat(43)}` }, ctx),
        );
        expect(statusOf(error)).toBe(400);
      }

      expect(attempt.attempts).toBe(0);
      expect(attempt.consumedAt).toBeNull();
    });

    it('rejects an expired link', async () => {
      const { h, attemptId, token } = await magicLogin();
      h.attempts.get(attemptId)!.lastSentAt = ago(601);

      await expect(h.service.confirm({ token }, ctx)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('malformed input', () => {
    it.each([
      ['nothing', {}],
      ['only a code', { code: '123456' }],
      [
        'only an attempt id',
        { attemptId: '0b8b6f4e-6a53-4b0c-9a51-0d3d7a4c9f10' },
      ],
      ['a token mixed with a code', { token: 'x.y', code: '123456' }],
      ['a token without a separator', { token: 'abcdef' }],
      [
        'a token with a non-uuid attempt id',
        { token: `nope.${'A'.repeat(43)}` },
      ],
      [
        'a token with a short secret',
        { token: '0b8b6f4e-6a53-4b0c-9a51-0d3d7a4c9f10.short' },
      ],
    ])(
      'answers 400 for %s without touching the database',
      async (_name, dto) => {
        const h = build();

        await expect(h.service.confirm(dto, ctx)).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(h.dataSource.transaction).not.toHaveBeenCalled();
      },
    );
  });
});

describe('LoginService.resend', () => {
  it('answers 429 inside the 60 second pause and sends nothing', async () => {
    const { h, attemptId, attempt } = await otpLogin();
    attempt.lastSentAt = ago(20);
    h.mail.sendLoginOtp.mockClear();
    const before = attempt.secretHash;

    const error = await failure(h.service.resend({ attemptId }, ctx));

    expect(statusOf(error)).toBe(429);
    expect((bodyOf(error) as Row).retryAfterSeconds).toBeGreaterThan(35);
    expect(h.mail.sendLoginOtp).not.toHaveBeenCalled();
    expect(attempt.secretHash).toBe(before);
  });

  it('after the pause replaces the secret, resets the counter and invalidates the old code', async () => {
    const { h, attemptId, code, attempt } = await otpLogin();
    attempt.lastSentAt = ago(61);
    attempt.attempts = 3;
    const oldHash = attempt.secretHash;
    h.mail.sendLoginOtp.mockClear();

    const result = await h.service.resend({ attemptId }, ctx);

    expect(result).toEqual({
      method: 'otp',
      attemptId,
      expiresInSeconds: 600,
      resendAfterSeconds: 60,
    });
    expect(result).not.toHaveProperty('confirmationRequired');
    expect(attempt.secretHash).not.toBe(oldHash);
    expect(attempt.attempts).toBe(0);
    expect(Date.now() - attempt.lastSentAt.getTime()).toBeLessThan(5000);

    const fresh: string = h.mail.sendLoginOtp.mock.calls[0][1];
    expect(fresh).toMatch(/^\d{6}$/);
    if (fresh !== code) {
      await expect(
        h.service.confirm({ attemptId, code }, ctx),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(
      h.service.confirm({ attemptId, code: fresh }, ctx),
    ).resolves.toMatchObject({ access: 'acc' });
  });

  it('never changes the method', async () => {
    const { h, attemptId } = await magicLogin();
    h.attempts.get(attemptId)!.lastSentAt = ago(61);
    // The configured method changes after the attempt exists.
    h.values.LOGIN_EMAIL_CONFIRMATION_METHOD = 'otp';

    const result = await h.service.resend({ attemptId }, ctx);

    expect(result.method).toBe('magic_link');
    expect(h.mail.sendLoginMagicLink).toHaveBeenCalledTimes(2);
  });

  it('allows resend after the code expired', async () => {
    const { h, attemptId, attempt } = await otpLogin();
    attempt.lastSentAt = ago(601);

    await expect(h.service.resend({ attemptId }, ctx)).resolves.toMatchObject({
      attemptId,
    });
  });

  it('answers 429 for an exhausted attempt', async () => {
    const { h, attemptId, attempt } = await otpLogin();
    attempt.consumedAt = new Date();
    attempt.consumedReason = LoginAttemptConsumedReason.ATTEMPTS_EXHAUSTED;

    const error = await failure(h.service.resend({ attemptId }, ctx));

    expect(statusOf(error)).toBe(429);
  });

  it.each([
    LoginAttemptConsumedReason.CONFIRMED,
    LoginAttemptConsumedReason.REPLACED,
    LoginAttemptConsumedReason.USER_INACTIVE,
  ])('answers 400 for a %s attempt', async (reason) => {
    const { h, attemptId, attempt } = await otpLogin();
    attempt.consumedAt = new Date();
    attempt.consumedReason = reason;

    const error = await failure(h.service.resend({ attemptId }, ctx));

    expect(statusOf(error)).toBe(400);
  });

  it('answers 400 for an unknown attempt', async () => {
    const h = build();

    await expect(
      h.service.resend(
        { attemptId: '0b8b6f4e-6a53-4b0c-9a51-0d3d7a4c9f10' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers 400 and consumes the attempt when the user is no longer active', async () => {
    const { h, attemptId, attempt } = await otpLogin();
    h.user.status = UserStatus.PENDING;
    attempt.lastSentAt = ago(61);

    await expect(h.service.resend({ attemptId }, ctx)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(attempt.consumedReason).toBe(
      LoginAttemptConsumedReason.USER_INACTIVE,
    );
  });

  it('keeps the new hash and answers 503 when SMTP rejects', async () => {
    const { h, attemptId, attempt } = await otpLogin();
    attempt.lastSentAt = ago(61);
    const oldHash = attempt.secretHash;
    h.mail.sendLoginOtp.mockRejectedValue(new Error('smtp down'));

    await expect(h.service.resend({ attemptId }, ctx)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(attempt.secretHash).not.toBe(oldHash);
    // The pause applies again, so the next send is allowed after 60 seconds.
    const again = await failure(h.service.resend({ attemptId }, ctx));
    expect(statusOf(again)).toBe(429);
  });
});
