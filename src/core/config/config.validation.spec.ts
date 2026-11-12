/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { configValidationSchema } from './config.validation';

const key = (char: string, bytes = 32) => char.repeat(bytes);

const valid = () => ({
  PORT: 3000,
  NODE_ENV: 'development',
  COOKIE_SECRET: 'cookie',
  REGISTRATION_SECRET: key('g', 16),
  JWT_ACCESS_SECRET: key('a'),
  JWT_REFRESH_SECRET: key('b'),
  LOGIN_CHALLENGE_HMAC_KEY: key('c'),
  AUTH_LOG_PSEUDONYM_KEY: key('d'),
  JWT_ISSUER: 'issuer',
  JWT_AUDIENCE: 'audience',
  POSTGRES_HOST: 'localhost',
  POSTGRES_PORT: 5432,
  POSTGRES_USER: 'user',
  POSTGRES_PASSWORD: 'password',
  POSTGRES_DB: 'db',
});

const validate = (config: Record<string, unknown>) =>
  configValidationSchema.validate(config);

const KEYS = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'LOGIN_CHALLENGE_HMAC_KEY',
  'AUTH_LOG_PSEUDONYM_KEY',
] as const;

describe('configValidationSchema (authentication)', () => {
  it('accepts a complete configuration and applies the defaults', () => {
    const { error, value } = validate(valid());

    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      LOGIN_EMAIL_CONFIRMATION_ENABLED: false,
      LOGIN_EMAIL_CONFIRMATION_METHOD: 'otp',
      LOGIN_THROTTLE_TTL: 60000,
      LOGIN_THROTTLE_LIMIT: 30,
      LOGIN_FAILURE_WINDOW_MS: 900000,
      LOGIN_FAILURE_LIMIT: 5,
      REFRESH_THROTTLE_TTL: 60000,
      REFRESH_THROTTLE_LIMIT: 30,
      AUTH_COOKIE_CROSS_SITE: false,
    });
  });

  it.each(KEYS)('refuses to start without %s', (name) => {
    const config: Record<string, unknown> = valid();
    delete config[name];

    expect(validate(config).error?.message).toContain(name);
  });

  it.each(KEYS)('refuses an empty %s', (name) => {
    expect(validate({ ...valid(), [name]: '' }).error?.message).toContain(name);
  });

  it.each(KEYS)('refuses a %s shorter than 32 bytes', (name) => {
    const { error } = validate({ ...valid(), [name]: key('x', 31) });

    expect(error?.message).toContain(name);
    expect(error?.message).toContain('32 bytes');
  });

  it.each(KEYS)('accepts a %s of exactly 32 bytes', (name) => {
    expect(
      validate({ ...valid(), [name]: key('x', 32) }).error,
    ).toBeUndefined();
  });

  it('counts bytes, not characters', () => {
    // 11 characters of 3 bytes each is 33 bytes.
    expect(
      validate({ ...valid(), JWT_ACCESS_SECRET: '€'.repeat(11) }).error,
    ).toBeUndefined();
  });

  it('refuses one key shared by several purposes', () => {
    const shared = key('s');

    const { error } = validate({
      ...valid(),
      JWT_ACCESS_SECRET: shared,
      JWT_REFRESH_SECRET: shared,
    });

    expect(error?.message).toContain('must all be different');
  });

  it('refuses a challenge key equal to a signing key', () => {
    const { error } = validate({
      ...valid(),
      LOGIN_CHALLENGE_HMAC_KEY: key('a'),
    });

    expect(error?.message).toContain('must all be different');
  });

  it.each(['JWT_ISSUER', 'JWT_AUDIENCE'])('requires %s', (name) => {
    const config: Record<string, unknown> = valid();
    delete config[name];

    expect(validate(config).error?.message).toContain(name);
  });

  it('only accepts otp or magic_link as the login method', () => {
    expect(
      validate({ ...valid(), LOGIN_EMAIL_CONFIRMATION_METHOD: 'sms' }).error,
    ).toBeDefined();
    expect(
      validate({ ...valid(), LOGIN_EMAIL_CONFIRMATION_METHOD: 'magic_link' })
        .error,
    ).toBeUndefined();
  });

  it('requires the trusted origin to be a URI when set', () => {
    expect(
      validate({ ...valid(), AUTH_TRUSTED_ORIGIN: 'not a url' }).error,
    ).toBeDefined();
    expect(
      validate({ ...valid(), AUTH_TRUSTED_ORIGIN: 'https://app.example.com' })
        .error,
    ).toBeUndefined();
    expect(
      validate({ ...valid(), AUTH_TRUSTED_ORIGIN: '' }).error,
    ).toBeUndefined();
  });
});

describe('configValidationSchema (user profile)', () => {
  it('applies the profile defaults (120 own / 60 foreign per minute)', () => {
    const { error, value } = validate(valid());

    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      PROFILE_READ_WINDOW_MS: 60000,
      PROFILE_READ_OWN_LIMIT: 120,
      PROFILE_READ_FOREIGN_LIMIT: 60,
      PHOTO_STORAGE_DIR: './storage/photos',
    });
  });

  it('accepts an http public url in development', () => {
    expect(
      validate({ ...valid(), API_PUBLIC_URL: 'http://localhost:3007' }).error,
    ).toBeUndefined();
  });

  it('requires an https public url in production', () => {
    const production = { ...valid(), NODE_ENV: 'production' };

    expect(
      validate({ ...production, API_PUBLIC_URL: 'http://api.example.com' })
        .error,
    ).toBeDefined();
    expect(
      validate({ ...production, API_PUBLIC_URL: 'https://api.example.com' })
        .error,
    ).toBeUndefined();
  });

  it('rejects a malformed public url', () => {
    expect(
      validate({ ...valid(), API_PUBLIC_URL: 'not a url' }).error,
    ).toBeDefined();
  });
});
