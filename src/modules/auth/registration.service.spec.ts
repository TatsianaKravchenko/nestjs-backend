/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call */
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';
import { User, UserStatus } from '@/modules/users/entities/user.entity';
import { UsersService } from '@/modules/users/users.service';

import {
  ConfirmationMethod,
  RegistrationAttempt,
} from './entities/registration-attempt.entity';
import { MailService } from './mail.service';
import { PasswordService } from './password.service';
import { MAX_OTP_FAILURES, RegistrationService } from './registration.service';

const SECRET = 'test-registration-secret';

interface Harness {
  service: RegistrationService;
  mail: {
    sendRegistrationOtp: jest.Mock;
    sendRegistrationMagicLink: jest.Mock;
  };
  usersRepo: { save: jest.Mock; create: jest.Mock };
  attemptsRepo: { findOne: jest.Mock; update: jest.Mock };
  usersService: { findByEmail: jest.Mock };
  manager: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock };
}

function build(settings: Record<string, string> = {}): Harness {
  const values: Record<string, string> = {
    REGISTRATION_CONFIRMATION_ENABLED: 'false',
    REGISTRATION_CONFIRMATION_METHOD: 'otp',
    REGISTRATION_SECRET: SECRET,
    REGISTRATION_MAGIC_LINK_URL: 'http://app.test/confirm',
    ...settings,
  };
  const manager = {
    create: jest.fn((_entity: unknown, data: object) => ({ ...data })),
    save: jest.fn((entity: object) =>
      Promise.resolve({ id: 'user-1', ...entity }),
    ),
    findOne: jest.fn(),
  };
  const dataSource = {
    transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)),
  };
  const usersRepo = {
    create: jest.fn((data: object) => data),
    save: jest.fn((data: object) => Promise.resolve({ id: 'user-1', ...data })),
  };
  const attemptsRepo = { findOne: jest.fn(), update: jest.fn() };
  const usersService = { findByEmail: jest.fn().mockResolvedValue(null) };
  const passwords = {
    hash: jest.fn().mockResolvedValue('$argon2id$hashed'),
  };
  const mail = {
    sendRegistrationOtp: jest.fn().mockResolvedValue(undefined),
    sendRegistrationMagicLink: jest.fn().mockResolvedValue(undefined),
  };
  const config = { get: (key: string) => values[key] };

  const service = new RegistrationService(
    dataSource as never,
    usersRepo as never,
    attemptsRepo as never,
    usersService as unknown as UsersService,
    passwords as unknown as PasswordService,
    mail as unknown as MailService,
    config as unknown as ConfigService,
  );
  return { service, mail, usersRepo, attemptsRepo, usersService, manager };
}

describe('RegistrationService.register', () => {
  it('creates an active user (201) when confirmation is disabled', async () => {
    const h = build();

    const result = await h.service.register({
      email: ' A@B.co ',
      password: 'abcdefg1',
    });

    expect(result.statusCode).toBe(HttpStatus.CREATED);
    expect(result.body).toEqual({
      id: 'user-1',
      email: 'a@b.co',
      status: UserStatus.ACTIVE,
    });
    expect(JSON.stringify(result.body)).not.toContain('hash');
    expect(h.usersRepo.create).toHaveBeenCalledWith({
      email: 'a@b.co',
      passwordHash: '$argon2id$hashed',
      status: UserStatus.ACTIVE,
    });
    expect(h.mail.sendRegistrationOtp).not.toHaveBeenCalled();
  });

  it('rejects an already registered email (409)', async () => {
    const h = build();
    h.usersService.findByEmail.mockResolvedValue({ id: 'x' });

    await expect(
      h.service.register({ email: 'a@b.co', password: 'abcdefg1' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a unique-constraint race to 409', async () => {
    const h = build();
    h.usersRepo.save.mockRejectedValue({ driverError: { code: '23505' } });

    await expect(
      h.service.register({ email: 'a@b.co', password: 'abcdefg1' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rethrows unexpected database errors', async () => {
    const h = build();
    const boom = new Error('db down');
    h.usersRepo.save.mockRejectedValue(boom);

    await expect(
      h.service.register({ email: 'a@b.co', password: 'abcdefg1' }),
    ).rejects.toBe(boom);
  });

  it('creates a pending user and emails an OTP (202) when enabled', async () => {
    const h = build({ REGISTRATION_CONFIRMATION_ENABLED: 'true' });

    const result = await h.service.register({
      email: 'a@b.co',
      password: 'abcdefg1',
    });

    expect(result.statusCode).toBe(HttpStatus.ACCEPTED);
    expect(result.body).toMatchObject({
      confirmationRequired: true,
      method: 'otp',
      expiresInSeconds: 600,
      resendAfterSeconds: 60,
    });
    expect(JSON.stringify(result.body)).not.toMatch(/code|token|secret/i);

    const userData = h.manager.create.mock.calls[0][1];
    expect(userData.status).toBe(UserStatus.PENDING);

    const [email, code] = h.mail.sendRegistrationOtp.mock.calls[0];
    expect(email).toBe('a@b.co');
    expect(code).toMatch(/^\d{6}$/);

    const attemptData = h.manager.create.mock.calls[1][1];
    expect(attemptData.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(attemptData.secretHash).not.toContain(code);
    expect(attemptData.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('emails a magic link containing a 32-byte token', async () => {
    const h = build({
      REGISTRATION_CONFIRMATION_ENABLED: 'true',
      REGISTRATION_CONFIRMATION_METHOD: 'magic_link',
    });

    const result = await h.service.register({
      email: 'a@b.co',
      password: 'abcdefg1',
    });

    expect(result.body).toMatchObject({ method: 'magic_link' });
    const link = new URL(h.mail.sendRegistrationMagicLink.mock.calls[0][1]);
    expect(link.origin + link.pathname).toBe('http://app.test/confirm');
    expect(
      Buffer.from(link.searchParams.get('token')!, 'base64url'),
    ).toHaveLength(32);
  });

  it('answers 503 when the email cannot be sent, keeping the records', async () => {
    const h = build({ REGISTRATION_CONFIRMATION_ENABLED: 'true' });
    h.mail.sendRegistrationOtp.mockRejectedValue(new Error('smtp down'));

    await expect(
      h.service.register({ email: 'a@b.co', password: 'abcdefg1' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(h.manager.save).toHaveBeenCalledTimes(2);
  });
});

describe('RegistrationService.confirm', () => {
  const pendingUser = (): Partial<User> => ({
    id: 'user-1',
    email: 'a@b.co',
    status: UserStatus.PENDING,
  });

  /** Registers with OTP to obtain a real attempt row and code. */
  async function otpAttempt() {
    const h = build({ REGISTRATION_CONFIRMATION_ENABLED: 'true' });
    await h.service.register({ email: 'a@b.co', password: 'abcdefg1' });
    const code: string = h.mail.sendRegistrationOtp.mock.calls[0][1];
    const attempt = {
      ...h.manager.create.mock.calls[1][1],
      id: h.manager.create.mock.calls[1][1].id as string,
    } as RegistrationAttempt;
    h.manager.save.mockClear();
    const user = pendingUser();
    h.manager.findOne.mockImplementation((entity: unknown) =>
      Promise.resolve(entity === User ? user : attempt),
    );
    return { h, code, attempt, user };
  }

  const wrongCode = (code: string) => (code === '000000' ? '000001' : '000000');

  it('activates the user with a correct OTP', async () => {
    const { h, code, attempt, user } = await otpAttempt();

    const result = await h.service.confirm({ attemptId: attempt.id, code });

    expect(result).toEqual({
      id: 'user-1',
      email: 'a@b.co',
      status: UserStatus.ACTIVE,
    });
    expect(attempt.consumedAt).toBeInstanceOf(Date);
    expect(user.status).toBe(UserStatus.ACTIVE);
  });

  it('counts wrong codes and still accepts the 5th attempt', async () => {
    const { h, code, attempt } = await otpAttempt();

    for (let i = 0; i < MAX_OTP_FAILURES - 1; i++) {
      await expect(
        h.service.confirm({ attemptId: attempt.id, code: wrongCode(code) }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(attempt.failedAttempts).toBe(MAX_OTP_FAILURES - 1);

    await expect(
      h.service.confirm({ attemptId: attempt.id, code }),
    ).resolves.toMatchObject({ status: UserStatus.ACTIVE });
  });

  it('burns the attempt on the 5th wrong code (429) and rejects a correct one afterwards', async () => {
    const { h, code, attempt } = await otpAttempt();

    for (let i = 0; i < MAX_OTP_FAILURES - 1; i++) {
      await h.service
        .confirm({ attemptId: attempt.id, code: wrongCode(code) })
        .catch(() => undefined);
    }
    const fifth = await h.service
      .confirm({ attemptId: attempt.id, code: wrongCode(code) })
      .catch((e: unknown) => e);

    expect(fifth).toBeInstanceOf(HttpException);
    expect((fifth as HttpException).getStatus()).toBe(429);
    expect(attempt.consumedAt).toBeInstanceOf(Date);

    await expect(
      h.service.confirm({ attemptId: attempt.id, code }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an expired attempt without incrementing the counter', async () => {
    const { h, code, attempt } = await otpAttempt();
    attempt.expiresAt = new Date(Date.now() - 1000);

    await expect(
      h.service.confirm({ attemptId: attempt.id, code: wrongCode(code) }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(attempt.failedAttempts).toBe(0);
    expect(h.manager.save).not.toHaveBeenCalled();
  });

  it('answers unknown attempts like a wrong code', async () => {
    const h = build();
    h.manager.findOne.mockResolvedValue(null);

    await expect(
      h.service.confirm({ attemptId: 'nope', code: '123456' }),
    ).rejects.toThrow('Invalid or expired confirmation');
  });

  it('rejects a payload with neither token nor attemptId+code', async () => {
    const h = build();

    await expect(h.service.confirm({})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(h.manager.findOne).not.toHaveBeenCalled();
  });

  it('confirms by magic link token once', async () => {
    const h = build({
      REGISTRATION_CONFIRMATION_ENABLED: 'true',
      REGISTRATION_CONFIRMATION_METHOD: 'magic_link',
    });
    await h.service.register({ email: 'a@b.co', password: 'abcdefg1' });
    const token = new URL(
      h.mail.sendRegistrationMagicLink.mock.calls[0][1],
    ).searchParams.get('token')!;
    const attempt = h.manager.create.mock.calls[1][1] as RegistrationAttempt;
    const user = pendingUser();
    h.manager.findOne.mockImplementation(
      (entity: unknown, opts: { where: { secretHash?: string } }) =>
        Promise.resolve(
          entity === User
            ? user
            : opts.where.secretHash === attempt.secretHash
              ? attempt
              : null,
        ),
    );

    await expect(h.service.confirm({ token })).resolves.toMatchObject({
      status: UserStatus.ACTIVE,
    });
    await expect(h.service.confirm({ token })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      h.service.confirm({ token: 'A'.repeat(43) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('RegistrationService.resend', () => {
  const pendingAttempt = {
    id: 'attempt-1',
    userId: 'user-1',
    method: ConfirmationMethod.OTP,
  };

  function ready() {
    const h = build({ REGISTRATION_CONFIRMATION_ENABLED: 'true' });
    h.usersService.findByEmail.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.co',
      status: UserStatus.PENDING,
    });
    h.attemptsRepo.findOne.mockResolvedValue(pendingAttempt);
    h.attemptsRepo.update.mockResolvedValue({ affected: 1 });
    return h;
  }

  it('issues a fresh code, resets the counter and returns 202 data', async () => {
    const h = ready();

    const result = await h.service.resend({ email: 'a@b.co' });

    expect(result).toMatchObject({
      attemptId: 'attempt-1',
      method: 'otp',
      expiresInSeconds: 600,
      resendAfterSeconds: 60,
    });
    expect(h.attemptsRepo.update.mock.calls[0][1]).toMatchObject({
      failedAttempts: 0,
      consumedAt: null,
    });
    expect(h.mail.sendRegistrationOtp.mock.calls[0][1]).toMatch(/^\d{6}$/);
  });

  it('returns 429 when resent within 60 seconds', async () => {
    const h = ready();
    h.attemptsRepo.update.mockResolvedValue({ affected: 0 });

    const error = await h.service
      .resend({ email: 'a@b.co' })
      .catch((e: unknown) => e);

    expect((error as HttpException).getStatus()).toBe(429);
    expect(h.mail.sendRegistrationOtp).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown email', null],
    ['active user', { id: 'u', status: UserStatus.ACTIVE }],
  ])('rejects %s with 400', async (_name, user) => {
    const h = ready();
    h.usersService.findByEmail.mockResolvedValue(user);

    await expect(h.service.resend({ email: 'a@b.co' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('answers 503 when delivery fails', async () => {
    const h = ready();
    h.mail.sendRegistrationOtp.mockRejectedValue(new Error('smtp down'));

    await expect(h.service.resend({ email: 'a@b.co' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
