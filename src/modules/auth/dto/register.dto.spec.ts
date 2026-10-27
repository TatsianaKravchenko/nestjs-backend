import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ConfirmRegistrationDto } from './confirm-registration.dto';
import { RegisterDto } from './register.dto';
import { ResendRegistrationDto } from './resend-registration.dto';

const errorsFor = async (payload: object) =>
  (await validate(plainToInstance(RegisterDto, payload))).map(
    (e) => e.property,
  );

describe('RegisterDto', () => {
  it('accepts a valid payload and normalizes the email for validation', async () => {
    const dto = plainToInstance(RegisterDto, {
      email: '  User+Tag@Example.COM ',
      password: 'abcdefg1',
    });

    expect(await validate(dto)).toHaveLength(0);
    expect(dto.email).toBe('user+tag@example.com');
  });

  it('keeps outer spaces of the password', async () => {
    const dto = plainToInstance(RegisterDto, {
      email: 'a@b.co',
      password: ' abcdef1 ',
    });

    expect(await validate(dto)).toHaveLength(0);
    expect(dto.password).toBe(' abcdef1 ');
  });

  it.each([
    ['invalid email', { email: 'nope', password: 'abcdefg1' }, 'email'],
    ['missing email', { password: 'abcdefg1' }, 'email'],
    ['too short', { email: 'a@b.co', password: 'abc1' }, 'password'],
    ['no digit', { email: 'a@b.co', password: 'abcdefgh' }, 'password'],
    ['no letter', { email: 'a@b.co', password: '12345678' }, 'password'],
    [
      'too long',
      { email: 'a@b.co', password: `a1${'x'.repeat(200)}` },
      'password',
    ],
    ['missing password', { email: 'a@b.co' }, 'password'],
  ])('rejects %s', async (_name, payload, property) => {
    expect(await errorsFor(payload)).toContain(property);
  });

  it('accepts non-latin letters', async () => {
    expect(
      await errorsFor({ email: 'a@b.co', password: 'пароль123' }),
    ).toHaveLength(0);
  });
});

describe('ResendRegistrationDto', () => {
  it('requires a valid email', async () => {
    const bad = plainToInstance(ResendRegistrationDto, { email: 'x' });
    const good = plainToInstance(ResendRegistrationDto, { email: ' A@B.co ' });

    expect(await validate(bad)).not.toHaveLength(0);
    expect(await validate(good)).toHaveLength(0);
    expect(good.email).toBe('a@b.co');
  });
});

describe('ConfirmRegistrationDto', () => {
  it('accepts attemptId + 6 digit code and a 43 char token', async () => {
    const otp = plainToInstance(ConfirmRegistrationDto, {
      attemptId: '0b8b6f4e-6a53-4b0c-9a51-0d3d7a4c9f10',
      code: '012345',
    });
    const link = plainToInstance(ConfirmRegistrationDto, {
      token: 'a'.repeat(43),
    });

    expect(await validate(otp)).toHaveLength(0);
    expect(await validate(link)).toHaveLength(0);
  });

  it('rejects malformed values', async () => {
    const dto = plainToInstance(ConfirmRegistrationDto, {
      attemptId: 'not-a-uuid',
      code: '12345',
      token: 'short',
    });

    expect((await validate(dto)).map((e) => e.property).sort()).toEqual([
      'attemptId',
      'code',
      'token',
    ]);
  });
});
