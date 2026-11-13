/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { HttpException } from '@nestjs/common';
import { createHmac } from 'crypto';

import { ConfirmationMethod } from '@/modules/auth/entities/registration-attempt.entity';

import {
  EmailChangeChallenge,
  EmailChangeConsumedReason,
} from '../../entities/email-change-challenge.entity';
import { User, UserStatus } from '../../entities/user.entity';
import {
  ConfirmEmailChangeDto,
  ResendEmailChangeDto,
  StartEmailChangeDto,
} from '../dto/update-user.dto';
import { EmailChangeService } from './email-change.service';

const USER_ID = '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44';
const CHALLENGE_ID = '0b9d6c3a-5e2f-4a7b-8c1d-2e3f4a5b6c7d';
const KEY = 'k'.repeat(48);
const CURRENT_EMAIL = 'current@example.test';
const NEW_EMAIL = 'new.address@example.test';
const ctx = { requestId: 'req-1', userId: USER_ID };

const hash = (id: string, secret: string) =>
  createHmac('sha256', KEY).update(`${id}:${secret}`).digest('hex');

const failure = async (promise: Promise<unknown>): Promise<HttpException> => {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected a rejection');
};
const statusOf = async (promise: Promise<unknown>) =>
  (await failure(promise)).getStatus();

const make = <T extends object>(Dto: new () => T, fields: Partial<T>): T =>
  Object.assign(new Dto(), fields);
const startDto = (newEmail: string) => make(StartEmailChangeDto, { newEmail });
const resendDto = (challengeId: string) =>
  make(ResendEmailChangeDto, { challengeId });
const confirmDto = (fields: Partial<ConfirmEmailChangeDto>) =>
  make(ConfirmEmailChangeDto, fields);

describe('EmailChangeService', () => {
  let env: Record<string, string>;
  let user: User;
  let previous: EmailChangeChallenge | null;
  let challenge: EmailChangeChallenge | null;
  let saved: EmailChangeChallenge[];
  const manager = {
    findOne: jest.fn(),
    findOneByOrFail: jest.fn(),
    existsBy: jest.fn(),
    update: jest.fn(),
    query: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
  };
  const dataSource = { transaction: jest.fn() };
  const mail = {
    sendEmailChangeOtp: jest.fn(),
    sendEmailChangeMagicLink: jest.fn(),
  };
  const limiter = { emailRetryAfter: jest.fn(), recordEmail: jest.fn() };
  const audit = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const config = { get: (key: string) => env[key] };
  const service = new EmailChangeService(
    dataSource as never,
    mail as never,
    config as never,
    limiter as never,
    audit as never,
  );

  const makeChallenge = (
    fields: Partial<EmailChangeChallenge> = {},
    secret = '123456',
  ) =>
    Object.assign(new EmailChangeChallenge(), {
      id: CHALLENGE_ID,
      userId: USER_ID,
      newEmail: NEW_EMAIL,
      method: ConfirmationMethod.OTP,
      secretHash: hash(CHALLENGE_ID, secret),
      attempts: 0,
      lastSentAt: new Date(),
      consumedAt: null,
      consumedReason: null,
      ...fields,
    });

  const auditDump = () =>
    JSON.stringify([
      ...audit.info.mock.calls,
      ...audit.warn.mock.calls,
      ...audit.error.mock.calls,
    ]);

  beforeEach(() => {
    jest.resetAllMocks();
    env = {
      EMAIL_CHANGE_HMAC_KEY: KEY,
      EMAIL_CHANGE_METHOD: 'otp',
      EMAIL_CHANGE_MAGIC_LINK_URL: 'https://app.test/confirm',
      API_PUBLIC_URL: 'https://api.test',
    };
    user = Object.assign(new User(), {
      id: USER_ID,
      email: CURRENT_EMAIL,
      displayName: null,
      photoKey: null,
      status: UserStatus.ACTIVE,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    });
    previous = null;
    challenge = null;
    saved = [];
    dataSource.transaction.mockImplementation((work: (m: unknown) => unknown) =>
      work(manager),
    );
    manager.findOne.mockImplementation((entity: unknown) =>
      Promise.resolve(
        entity === User
          ? user
          : entity === EmailChangeChallenge
            ? (challenge ?? previous)
            : null,
      ),
    );
    manager.existsBy.mockResolvedValue(false);
    manager.create.mockImplementation((_e: unknown, fields: object) =>
      Object.assign(new EmailChangeChallenge(), fields),
    );
    manager.save.mockImplementation((value: EmailChangeChallenge) => {
      saved.push(value);
      return Promise.resolve(value);
    });
    manager.query.mockResolvedValue([]);
    manager.update.mockResolvedValue(undefined);
    manager.findOneByOrFail.mockImplementation(() =>
      Promise.resolve(Object.assign(new User(), user, { email: NEW_EMAIL })),
    );
    limiter.emailRetryAfter.mockReturnValue(0);
    mail.sendEmailChangeOtp.mockResolvedValue(undefined);
    mail.sendEmailChangeMagicLink.mockResolvedValue(undefined);
  });

  /* ---------------------------------- start --------------------------------- */

  describe('start', () => {
    it('normalizes the address, stores an HMAC and mails the OTP to the new address only', async () => {
      const result = await service.start(
        ctx,
        startDto('  New.Address@Example.TEST '),
      );

      expect(result).toMatchObject({
        confirmationRequired: true,
        method: 'otp',
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });
      expect(Object.keys(result).sort()).toEqual([
        'challengeId',
        'confirmationRequired',
        'expiresInSeconds',
        'method',
        'resendAfterSeconds',
      ]);
      const [to, code] = mail.sendEmailChangeOtp.mock.calls[0] as string[];
      expect(to).toBe(NEW_EMAIL);
      expect(code).toMatch(/^\d{6}$/);
      const stored = saved[0];
      expect(stored.newEmail).toBe(NEW_EMAIL);
      expect(stored.secretHash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.secretHash).toBe(hash(stored.id, code));
      expect(stored.secretHash).not.toBe(code);
      expect(stored.attempts).toBe(0);
      expect(limiter.recordEmail).toHaveBeenCalledWith(USER_ID);
    });

    it('sends a magic link with the token in the fragment', async () => {
      env.EMAIL_CHANGE_METHOD = 'magic_link';

      const result = await service.start(ctx, startDto(NEW_EMAIL));

      expect(result.method).toBe('magic_link');
      const [to, link] = mail.sendEmailChangeMagicLink.mock
        .calls[0] as string[];
      const url = new URL(link);
      expect(to).toBe(NEW_EMAIL);
      expect(url.search).toBe('');
      const token = url.hash.replace('#token=', '');
      const [id, secret] = token.split('.');
      expect(id).toBe(result.challengeId);
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(saved[0].secretHash).toBe(hash(id, secret));
    });

    it('409 for the current address and for an occupied one, nothing is sent', async () => {
      expect(
        await statusOf(service.start(ctx, startDto('CURRENT@example.test'))),
      ).toBe(409);
      manager.existsBy.mockResolvedValue(true);
      expect(await statusOf(service.start(ctx, startDto(NEW_EMAIL)))).toBe(409);

      expect(mail.sendEmailChangeOtp).not.toHaveBeenCalled();
      expect(saved).toHaveLength(0);
    });

    it('401 when the user is not active any more', async () => {
      user.status = UserStatus.BLOCKED;

      expect(await statusOf(service.start(ctx, startDto(NEW_EMAIL)))).toBe(401);
    });

    it('429 with the remaining time inside the 60 second pause', async () => {
      previous = makeChallenge({ lastSentAt: new Date(Date.now() - 20_000) });

      const error = await failure(service.start(ctx, startDto(NEW_EMAIL)));

      expect(error.getStatus()).toBe(429);
      const { retryAfterSeconds } = error.getResponse() as {
        retryAfterSeconds: number;
      };
      expect(retryAfterSeconds).toBeGreaterThan(30);
      expect(retryAfterSeconds).toBeLessThanOrEqual(40);
      expect(mail.sendEmailChangeOtp).not.toHaveBeenCalled();
    });

    it('replaces the previous challenge after the pause', async () => {
      previous = makeChallenge({
        id: 'older',
        lastSentAt: new Date(Date.now() - 120_000),
      });

      await service.start(ctx, startDto(NEW_EMAIL));

      expect(previous.consumedReason).toBe(EmailChangeConsumedReason.REPLACED);
      expect(previous.consumedAt).toBeInstanceOf(Date);
      expect(saved[0]).toBe(previous);
      expect(saved).toHaveLength(2);
    });

    it('429 on the hourly email limit before touching the database', async () => {
      limiter.emailRetryAfter.mockReturnValue(1800);

      const error = await failure(service.start(ctx, startDto(NEW_EMAIL)));

      expect(error.getStatus()).toBe(429);
      expect(
        (error.getResponse() as { retryAfterSeconds: number })
          .retryAfterSeconds,
      ).toBe(1800);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('503 with safe metadata only when SMTP fails after the commit', async () => {
      mail.sendEmailChangeOtp.mockRejectedValue(new Error('smtp down'));

      const error = await failure(service.start(ctx, startDto(NEW_EMAIL)));

      expect(error.getStatus()).toBe(503);
      const body = error.getResponse() as Record<string, unknown>;
      expect(body).toMatchObject({
        confirmationRequired: true,
        method: 'otp',
        challengeId: saved[0].id,
      });
      expect(typeof body.retryAfterSeconds).toBe('number');
      const code = (mail.sendEmailChangeOtp.mock.calls[0] as string[])[1];
      const dumped = JSON.stringify(body);
      expect(dumped).not.toContain(code + '"');
      expect(dumped).not.toContain(NEW_EMAIL);
      expect(dumped).not.toContain(saved[0].secretHash);
      expect(audit.error).toHaveBeenCalledWith(
        'users.email_change.delivery_unavailable',
        expect.objectContaining({ challengeId: saved[0].id }),
      );
    });

    it('503 when the database fails', async () => {
      dataSource.transaction.mockRejectedValue(new Error('down'));

      expect(await statusOf(service.start(ctx, startDto(NEW_EMAIL)))).toBe(503);
      expect(mail.sendEmailChangeOtp).not.toHaveBeenCalled();
    });

    it('never logs addresses, codes or hashes', async () => {
      await service.start(ctx, startDto(NEW_EMAIL));

      const code = (mail.sendEmailChangeOtp.mock.calls[0] as string[])[1];
      const logged = auditDump();
      for (const secret of [
        NEW_EMAIL,
        CURRENT_EMAIL,
        code,
        saved[0].secretHash,
        KEY,
      ]) {
        expect(logged).not.toContain(secret);
      }
      expect(logged).toContain('users.email_change.created');
    });
  });

  /* --------------------------------- resend --------------------------------- */

  describe('resend', () => {
    it('rotates the secret, resets the counter and mails the same address', async () => {
      challenge = makeChallenge({
        attempts: 3,
        lastSentAt: new Date(Date.now() - 61_000),
      });
      const oldHash = challenge.secretHash;

      const result = await service.resend(ctx, resendDto(CHALLENGE_ID));

      expect(result.challengeId).toBe(CHALLENGE_ID);
      expect(challenge.attempts).toBe(0);
      expect(challenge.secretHash).not.toBe(oldHash);
      expect(challenge.secretHash).toMatch(/^[0-9a-f]{64}$/);
      const [to, code] = mail.sendEmailChangeOtp.mock.calls[0] as string[];
      expect(to).toBe(NEW_EMAIL);
      expect(challenge.secretHash).toBe(hash(CHALLENGE_ID, code));
      expect(Date.now() - challenge.lastSentAt.getTime()).toBeLessThan(5000);
    });

    it('429 inside the pause, without changing the secret', async () => {
      challenge = makeChallenge({ lastSentAt: new Date(Date.now() - 5_000) });
      const oldHash = challenge.secretHash;

      expect(await statusOf(service.resend(ctx, resendDto(CHALLENGE_ID)))).toBe(
        429,
      );
      expect(challenge.secretHash).toBe(oldHash);
      expect(mail.sendEmailChangeOtp).not.toHaveBeenCalled();
    });

    it('400 for an unknown challenge or a non-uuid id', async () => {
      expect(await statusOf(service.resend(ctx, resendDto(CHALLENGE_ID)))).toBe(
        400,
      );
      expect(await statusOf(service.resend(ctx, resendDto('nope')))).toBe(400);
    });

    it.each([
      [EmailChangeConsumedReason.CONFIRMED, 400],
      [EmailChangeConsumedReason.REPLACED, 400],
      [EmailChangeConsumedReason.USER_INACTIVE, 400],
      [EmailChangeConsumedReason.ATTEMPTS_EXHAUSTED, 429],
      [EmailChangeConsumedReason.ADMIN_OVERRIDE, 409],
      [EmailChangeConsumedReason.EMAIL_CONFLICT, 409],
    ])('maps a challenge consumed as %s to %i', async (reason, status) => {
      challenge = makeChallenge({
        consumedAt: new Date(),
        consumedReason: reason,
      });

      expect(await statusOf(service.resend(ctx, resendDto(CHALLENGE_ID)))).toBe(
        status,
      );
      expect(mail.sendEmailChangeOtp).not.toHaveBeenCalled();
    });

    it('401 when the user is not active', async () => {
      user.status = UserStatus.BLOCKED;

      expect(await statusOf(service.resend(ctx, resendDto(CHALLENGE_ID)))).toBe(
        401,
      );
    });

    it('429 on the hourly limit', async () => {
      limiter.emailRetryAfter.mockReturnValue(10);

      expect(await statusOf(service.resend(ctx, resendDto(CHALLENGE_ID)))).toBe(
        429,
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('503 with safe metadata when SMTP fails; the new secret stays stored', async () => {
      challenge = makeChallenge({ lastSentAt: new Date(Date.now() - 61_000) });
      mail.sendEmailChangeOtp.mockRejectedValue(new Error('smtp down'));

      const error = await failure(service.resend(ctx, resendDto(CHALLENGE_ID)));

      expect(error.getStatus()).toBe(503);
      expect(error.getResponse()).toMatchObject({
        confirmationRequired: true,
        challengeId: CHALLENGE_ID,
      });
      expect(saved).toContain(challenge);
    });
  });

  /* --------------------------------- confirm -------------------------------- */

  describe('confirm', () => {
    const otp = (code: string) =>
      confirmDto({ challengeId: CHALLENGE_ID, code });

    it('succeeds: updates the email, consumes as confirmed, returns the profile', async () => {
      challenge = makeChallenge();

      const profile = await service.confirm(ctx, otp('123456'));

      expect(profile.email).toBe(NEW_EMAIL);
      expect(manager.update).toHaveBeenCalledWith(
        User,
        { id: USER_ID },
        { email: NEW_EMAIL },
      );
      expect(challenge.consumedReason).toBe(
        EmailChangeConsumedReason.CONFIRMED,
      );
      const sql = manager.query.mock.calls.map(([q]) => String(q));
      expect(sql).toEqual([
        'SAVEPOINT email_change_update',
        'RELEASE SAVEPOINT email_change_update',
      ]);
      expect(audit.info).toHaveBeenCalledWith(
        'users.email_change.confirmed',
        expect.objectContaining({ challengeId: CHALLENGE_ID }),
      );
    });

    it('succeeds with a magic link token', async () => {
      const secret = 'A'.repeat(43);
      challenge = makeChallenge(
        { method: ConfirmationMethod.MAGIC_LINK },
        secret,
      );

      const profile = await service.confirm(
        ctx,
        confirmDto({ token: `${CHALLENGE_ID}.${secret}` }),
      );

      expect(profile.email).toBe(NEW_EMAIL);
    });

    it.each([
      ['empty body', {}],
      ['challengeId without code', { challengeId: CHALLENGE_ID }],
      ['code without challengeId', { code: '123456' }],
      ['non-uuid challengeId', { challengeId: 'x', code: '123456' }],
      [
        'token plus code',
        { token: `${CHALLENGE_ID}.${'A'.repeat(43)}`, code: '123456' },
      ],
      [
        'token plus challengeId',
        {
          token: `${CHALLENGE_ID}.${'A'.repeat(43)}`,
          challengeId: CHALLENGE_ID,
        },
      ],
      ['token without separator', { token: 'abc' }],
      ['token with bad id', { token: `nope.${'A'.repeat(43)}` }],
      ['token with short secret', { token: `${CHALLENGE_ID}.short` }],
    ])(
      '400 for a malformed body (%s) without a transaction',
      async (_n, fields) => {
        expect(await statusOf(service.confirm(ctx, confirmDto(fields)))).toBe(
          400,
        );
        expect(dataSource.transaction).not.toHaveBeenCalled();
      },
    );

    it('400 for an unknown challenge', async () => {
      expect(await statusOf(service.confirm(ctx, otp('123456')))).toBe(400);
    });

    it.each([
      [EmailChangeConsumedReason.CONFIRMED, 400],
      [EmailChangeConsumedReason.REPLACED, 400],
      [EmailChangeConsumedReason.USER_INACTIVE, 400],
      [EmailChangeConsumedReason.ATTEMPTS_EXHAUSTED, 429],
      [EmailChangeConsumedReason.ADMIN_OVERRIDE, 409],
      [EmailChangeConsumedReason.EMAIL_CONFLICT, 409],
    ])('maps a challenge consumed as %s to %i', async (reason, status) => {
      challenge = makeChallenge({
        consumedAt: new Date(),
        consumedReason: reason,
      });

      expect(await statusOf(service.confirm(ctx, otp('123456')))).toBe(status);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('400 for an expired challenge without counting an attempt', async () => {
      challenge = makeChallenge({
        lastSentAt: new Date(Date.now() - 11 * 60_000),
      });

      expect(await statusOf(service.confirm(ctx, otp('000000')))).toBe(400);
      expect(challenge.attempts).toBe(0);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('401 and consumes the challenge when the user is no longer active', async () => {
      challenge = makeChallenge();
      user.status = UserStatus.BLOCKED;

      expect(await statusOf(service.confirm(ctx, otp('123456')))).toBe(401);
      expect(challenge.consumedReason).toBe(
        EmailChangeConsumedReason.USER_INACTIVE,
      );
      expect(manager.save).toHaveBeenCalledWith(challenge);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('400 without counting when the form does not match the challenge method', async () => {
      challenge = makeChallenge({ method: ConfirmationMethod.MAGIC_LINK });

      expect(await statusOf(service.confirm(ctx, otp('123456')))).toBe(400);
      expect(challenge.attempts).toBe(0);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('counts a wrong OTP', async () => {
      challenge = makeChallenge();

      expect(await statusOf(service.confirm(ctx, otp('000000')))).toBe(400);
      expect(challenge.attempts).toBe(1);
      expect(challenge.consumedAt).toBeNull();
      expect(manager.save).toHaveBeenCalledWith(challenge);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('the fifth wrong OTP is 400 and exhausts; the next request is 429', async () => {
      challenge = makeChallenge({ attempts: 4 });

      expect(await statusOf(service.confirm(ctx, otp('000000')))).toBe(400);
      expect(challenge.attempts).toBe(5);
      expect(challenge.consumedReason).toBe(
        EmailChangeConsumedReason.ATTEMPTS_EXHAUSTED,
      );

      // even the right code is refused now
      expect(await statusOf(service.confirm(ctx, otp('123456')))).toBe(429);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('a wrong magic link has no counter', async () => {
      challenge = makeChallenge(
        { method: ConfirmationMethod.MAGIC_LINK },
        'A'.repeat(43),
      );

      const status = await statusOf(
        service.confirm(
          ctx,
          confirmDto({ token: `${CHALLENGE_ID}.${'B'.repeat(43)}` }),
        ),
      );

      expect(status).toBe(400);
      expect(challenge.attempts).toBe(0);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('409 and email_conflict when the unique index rejects the UPDATE (savepoint flow)', async () => {
      challenge = makeChallenge();
      manager.update.mockRejectedValue({ driverError: { code: '23505' } });

      const error = await failure(service.confirm(ctx, otp('123456')));

      expect(error.getStatus()).toBe(409);
      expect(challenge.consumedReason).toBe(
        EmailChangeConsumedReason.EMAIL_CONFLICT,
      );
      const sql = manager.query.mock.calls.map(([q]) => String(q));
      expect(sql).toEqual([
        'SAVEPOINT email_change_update',
        'ROLLBACK TO SAVEPOINT email_change_update',
      ]);
      expect(manager.save).toHaveBeenCalledWith(challenge);
      expect(audit.warn).toHaveBeenCalledWith(
        'users.email_change.conflict',
        expect.objectContaining({ challengeId: CHALLENGE_ID }),
      );
    });

    it('rethrows an unexpected UPDATE failure as 503 and consumes nothing', async () => {
      challenge = makeChallenge();
      manager.update.mockRejectedValue(new Error('boom'));

      expect(await statusOf(service.confirm(ctx, otp('123456')))).toBe(503);
      expect(challenge.consumedAt).toBeNull();
    });

    it('never logs addresses, codes, tokens or hashes', async () => {
      challenge = makeChallenge();
      await service.confirm(ctx, otp('123456'));
      challenge = makeChallenge({ attempts: 4 });
      await failure(service.confirm(ctx, otp('654321')));
      await failure(
        service.confirm(ctx, confirmDto({ token: 'garbage-token' })),
      );

      const logged = auditDump();
      for (const secret of [
        NEW_EMAIL,
        CURRENT_EMAIL,
        '123456',
        '654321',
        'garbage-token',
        hash(CHALLENGE_ID, '123456'),
        KEY,
      ]) {
        expect(logged).not.toContain(secret);
      }
    });
  });
});
