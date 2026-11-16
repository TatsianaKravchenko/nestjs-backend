import { HttpException } from '@nestjs/common';

import { ConfirmationMethod } from '@/modules/auth/entities/registration-attempt.entity';

import { User, UserStatus } from '../../entities/user.entity';
import {
  DeletionChallenge,
  DeletionChallengeConsumedReason,
} from '../entities/deletion-challenge.entity';
import {
  DeletionChallengeService,
  hashDeletionSecret,
} from './deletion-challenge.service';

const USER_ID = '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44';
const CHALLENGE_ID = '0b9d6c3a-5e2f-4a7b-8c1d-2e3f4a5b6c7d';
const KEY = 'k'.repeat(48);
const EMAIL = 'someone@example.test';
const ctx = { requestId: 'req-1', userId: USER_ID };

const failure = async (promise: Promise<unknown>): Promise<HttpException> => {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected a rejection');
};
const codeOf = async (promise: Promise<unknown>) => {
  const error = await failure(promise);
  return [
    error.getStatus(),
    (error.getResponse() as { code?: string }).code,
  ] as const;
};

describe('DeletionChallengeService', () => {
  let env: Record<string, string>;
  let user: User | null;
  let found: DeletionChallenge | null;
  let saved: DeletionChallenge[];
  const manager = {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
  };
  const dataSource = { transaction: jest.fn() };
  const mail = { sendDeletionOtp: jest.fn(), sendDeletionMagicLink: jest.fn() };
  const limiter = { emailRetryAfter: jest.fn(), recordEmail: jest.fn() };
  const audit = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const config = { get: (key: string) => env[key] };
  const service = new DeletionChallengeService(
    dataSource as never,
    mail as never,
    config as never,
    limiter as never,
    audit as never,
  );

  const makeChallenge = (
    fields: Partial<DeletionChallenge> = {},
  ): DeletionChallenge =>
    ({
      id: CHALLENGE_ID,
      userId: USER_ID,
      method: ConfirmationMethod.OTP,
      secretHash: 'old-hash',
      attempts: 3,
      lastSentAt: new Date(Date.now() - 120_000),
      consumedAt: null,
      consumedReason: null,
      ...fields,
    }) as DeletionChallenge;

  const callsOf = (fn: jest.Mock): unknown[][] => fn.mock.calls as unknown[][];
  const sentOtp = (): string => String(callsOf(mail.sendDeletionOtp)[0][1]);

  beforeEach(() => {
    jest.resetAllMocks();
    env = {
      DELETION_CHALLENGE_HMAC_KEY: KEY,
      DELETION_CONFIRMATION_METHOD: 'otp',
      DELETION_MAGIC_LINK_URL: 'https://app.test/deletion/confirm',
    };
    user = { id: USER_ID, email: EMAIL, status: UserStatus.ACTIVE } as User;
    found = null;
    saved = [];
    dataSource.transaction.mockImplementation((work: (m: unknown) => unknown) =>
      work(manager),
    );
    manager.findOne.mockImplementation((entity: unknown) =>
      Promise.resolve(entity === User ? user : found),
    );
    manager.create.mockImplementation((_entity: unknown, fields: object) => ({
      ...fields,
    }));
    manager.save.mockImplementation((value: DeletionChallenge) => {
      saved.push({ ...value });
      return Promise.resolve(value);
    });
    limiter.emailRetryAfter.mockReturnValue(0);
    mail.sendDeletionOtp.mockResolvedValue(undefined);
    mail.sendDeletionMagicLink.mockResolvedValue(undefined);
  });

  /** Nothing in the log may identify the user or reveal a secret. */
  afterEach(() => {
    const logged = JSON.stringify([
      audit.info.mock.calls,
      audit.warn.mock.calls,
      audit.error.mock.calls,
    ]);
    expect(logged).not.toContain(USER_ID);
    expect(logged).not.toContain(CHALLENGE_ID);
    expect(logged).not.toContain(EMAIL);
    expect(logged).not.toContain('req-1');
    for (const call of [
      ...callsOf(mail.sendDeletionOtp),
      ...callsOf(mail.sendDeletionMagicLink),
    ]) {
      expect(logged).not.toContain(String(call[1]));
    }
  });

  describe('start', () => {
    it('sends a 6-digit OTP to the current email and stores only its HMAC', async () => {
      const result = await service.start(ctx);

      expect(result).toMatchObject({
        confirmationRequired: true,
        method: ConfirmationMethod.OTP,
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });
      expect(result.challengeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(mail.sendDeletionOtp).toHaveBeenCalledWith(EMAIL, sentOtp());
      expect(sentOtp()).toMatch(/^\d{6}$/);
      expect(JSON.stringify(result)).not.toContain(sentOtp());
      expect(saved[0]).toMatchObject({
        userId: USER_ID,
        method: ConfirmationMethod.OTP,
        attempts: 0,
        consumedAt: null,
        secretHash: hashDeletionSecret(
          config as never,
          result.challengeId,
          sentOtp(),
        ),
      });
      expect(limiter.recordEmail).toHaveBeenCalledWith(USER_ID);
      expect(audit.info).toHaveBeenCalledWith('users.deletion.challenge', {
        result: 'sent',
      });
    });

    it('sends the magic link token in the URL fragment only', async () => {
      env.DELETION_CONFIRMATION_METHOD = 'magic_link';

      const result = await service.start(ctx);

      expect(result.method).toBe(ConfirmationMethod.MAGIC_LINK);
      expect(mail.sendDeletionOtp).not.toHaveBeenCalled();
      const [to, link] = mail.sendDeletionMagicLink.mock.calls[0] as [
        string,
        string,
      ];
      expect(to).toBe(EMAIL);
      const url = new URL(link);
      expect(url.search).toBe('');
      expect(url.hash).toMatch(
        new RegExp(`^#token=${result.challengeId}\\.[A-Za-z0-9_-]{43}$`),
      );
    });

    it('answers 429 with the wait when the hourly budget is used up', async () => {
      limiter.emailRetryAfter.mockReturnValue(1800);

      const error = await failure(service.start(ctx));

      expect(error.getStatus()).toBe(429);
      expect(error.getResponse()).toMatchObject({ retryAfterSeconds: 1800 });
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(mail.sendDeletionOtp).not.toHaveBeenCalled();
      expect(audit.warn).toHaveBeenCalledWith('users.deletion.rate_limited', {
        result: 'rate_limited',
      });
    });

    it.each([
      ['a blocked user', { status: UserStatus.BLOCKED }],
      ['a deleting user', { status: UserStatus.DELETING }],
      ['a missing user', null],
    ])('answers 401 for %s', async (_name, fields) => {
      user = fields && ({ id: USER_ID, email: EMAIL, ...fields } as User);

      expect(await codeOf(service.start(ctx))).toEqual([
        401,
        'invalid_session',
      ]);
      expect(mail.sendDeletionOtp).not.toHaveBeenCalled();
      expect(audit.warn).toHaveBeenCalledWith(
        'users.deletion.challenge_start',
        { result: 'inactive' },
      );
    });

    it('answers 429 while the previous challenge is inside the 60 s pause', async () => {
      found = makeChallenge({ lastSentAt: new Date(Date.now() - 10_000) });

      const error = await failure(service.start(ctx));

      expect(error.getStatus()).toBe(429);
      const { retryAfterSeconds } = error.getResponse() as {
        retryAfterSeconds: number;
      };
      expect(retryAfterSeconds).toBeGreaterThan(0);
      expect(retryAfterSeconds).toBeLessThanOrEqual(50);
      expect(mail.sendDeletionOtp).not.toHaveBeenCalled();
    });

    it('replaces the previous challenge once the pause is over', async () => {
      found = makeChallenge();

      await service.start(ctx);

      expect(found).toMatchObject({
        consumedReason: DeletionChallengeConsumedReason.REPLACED,
      });
      expect(found.consumedAt).toBeInstanceOf(Date);
      expect(saved).toHaveLength(2);
    });

    it('answers 503 without a secret when SMTP fails, keeping the challenge', async () => {
      mail.sendDeletionOtp.mockRejectedValue(new Error('smtp down'));

      const error = await failure(service.start(ctx));

      expect(error.getStatus()).toBe(503);
      const body = error.getResponse() as Record<string, unknown>;
      expect(body).toMatchObject({
        code: 'deletion_unavailable',
        confirmationRequired: true,
        method: ConfirmationMethod.OTP,
        challengeId: saved[0].id,
      });
      expect(body.retryAfterSeconds).toBeGreaterThan(0);
      expect(JSON.stringify(body)).not.toContain(sentOtp());
      expect(limiter.recordEmail).toHaveBeenCalledTimes(1);
      expect(audit.error).toHaveBeenCalledWith('users.deletion.challenge', {
        result: 'delivery_unavailable',
      });
    });

    it('answers 503 when the database fails', async () => {
      dataSource.transaction.mockRejectedValue(new Error('down'));

      expect(await codeOf(service.start(ctx))).toEqual([
        503,
        'service_unavailable',
      ]);
      expect(audit.error).toHaveBeenCalledWith(
        'users.deletion.database_unavailable',
      );
      expect(mail.sendDeletionOtp).not.toHaveBeenCalled();
    });
  });

  describe('resend', () => {
    const dto = { challengeId: CHALLENGE_ID };

    it('sends a new secret, voids the old one and resets the attempts', async () => {
      found = makeChallenge();

      const result = await service.resend(ctx, dto);

      expect(result).toMatchObject({
        challengeId: CHALLENGE_ID,
        method: ConfirmationMethod.OTP,
      });
      expect(found.attempts).toBe(0);
      expect(found.secretHash).toBe(
        hashDeletionSecret(config as never, CHALLENGE_ID, sentOtp()),
      );
      expect(found.secretHash).not.toBe('old-hash');
      expect(Date.now() - found.lastSentAt.getTime()).toBeLessThan(5_000);
      expect(mail.sendDeletionOtp).toHaveBeenCalledWith(EMAIL, sentOtp());
      expect(limiter.recordEmail).toHaveBeenCalledWith(USER_ID);
    });

    it('resends a magic link challenge as a link', async () => {
      found = makeChallenge({ method: ConfirmationMethod.MAGIC_LINK });

      await service.resend(ctx, dto);

      expect(mail.sendDeletionOtp).not.toHaveBeenCalled();
      const link = String(callsOf(mail.sendDeletionMagicLink)[0][1]);
      expect(new URL(link).hash).toContain(`#token=${CHALLENGE_ID}.`);
    });

    it('answers 429 when the email budget is used up', async () => {
      limiter.emailRetryAfter.mockReturnValue(60);
      expect(await codeOf(service.resend(ctx, dto))).toEqual([
        429,
        'rate_limit_exceeded',
      ]);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('answers 429 inside the 60 s pause', async () => {
      found = makeChallenge({ lastSentAt: new Date() });
      expect(await codeOf(service.resend(ctx, dto))).toEqual([
        429,
        'rate_limit_exceeded',
      ]);
      expect(mail.sendDeletionOtp).not.toHaveBeenCalled();
    });

    it('answers 401 for an inactive or missing user', async () => {
      user = { id: USER_ID, status: UserStatus.BLOCKED } as User;
      expect(await codeOf(service.resend(ctx, dto))).toEqual([
        401,
        'invalid_session',
      ]);
      user = null;
      expect(await codeOf(service.resend(ctx, dto))).toEqual([
        401,
        'invalid_session',
      ]);
    });

    it.each([
      ['a malformed id', { challengeId: 'nope' }, null],
      ['an unknown challenge', dto, null],
      [
        'a consumed challenge',
        dto,
        makeChallenge({
          consumedAt: new Date(),
          consumedReason: DeletionChallengeConsumedReason.CONFIRMED,
        }),
      ],
    ])('answers 400 for %s', async (_name, body, challenge) => {
      found = challenge;
      expect(await codeOf(service.resend(ctx, body))).toEqual([
        400,
        'invalid_confirmation',
      ]);
      expect(mail.sendDeletionOtp).not.toHaveBeenCalled();
      expect(audit.warn).toHaveBeenCalledWith(
        'users.deletion.challenge_resend',
        { result: 'invalid' },
      );
    });

    it('answers 429 for an exhausted challenge', async () => {
      found = makeChallenge({
        consumedAt: new Date(),
        consumedReason: DeletionChallengeConsumedReason.ATTEMPTS_EXHAUSTED,
      });
      expect(await codeOf(service.resend(ctx, dto))).toEqual([
        429,
        'rate_limit_exceeded',
      ]);
      expect(audit.warn).toHaveBeenCalledWith(
        'users.deletion.challenge_resend',
        { result: 'exhausted' },
      );
    });
  });
});
