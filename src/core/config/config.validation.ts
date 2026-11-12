import Joi from 'joi';

import { Config } from './config.types';

const MIN_KEY_BYTES = 32;
const DISTINCT_KEYS = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'LOGIN_CHALLENGE_HMAC_KEY',
  'AUTH_LOG_PSEUDONYM_KEY',
] as const;

const strongKey = () =>
  Joi.string()
    .required()
    .custom((value: string, helpers) =>
      Buffer.byteLength(value) >= MIN_KEY_BYTES
        ? value
        : helpers.message({
            custom: `"{#label}" must be at least ${MIN_KEY_BYTES} bytes`,
          }),
    );

export const configValidationSchema = Joi.object<Config>({
  PORT: Joi.number().port().required(),
  NODE_ENV: Joi.string().valid('development', 'production').required(),

  /**
   * Cookie secret
   */
  COOKIE_SECRET: Joi.string().required(),

  /**
   * Health check options
   */
  HEALTH_CHECK_ENABLED: Joi.boolean().optional().default(false),

  /**
   * Throttler options
   */
  THROTTLE_GLOBAL_TTL: Joi.number().optional().default(10000),
  THROTTLE_GLOBAL_LIMIT: Joi.number().optional().default(10),

  /**
   * Registration options
   */
  REGISTRATION_CONFIRMATION_ENABLED: Joi.boolean().optional().default(false),
  REGISTRATION_CONFIRMATION_METHOD: Joi.string()
    .valid('otp', 'magic_link')
    .optional()
    .default('otp'),
  REGISTRATION_SECRET: Joi.string().min(16).required(),
  REGISTRATION_MAGIC_LINK_URL: Joi.string()
    .uri()
    .optional()
    .default('http://localhost:4200/auth/register/confirm'),
  REGISTRATION_THROTTLE_TTL: Joi.number().optional().default(60000),
  REGISTRATION_THROTTLE_LIMIT: Joi.number().optional().default(5),

  /**
   * Authentication options. Every key must be random, at least 32 bytes and
   * distinct from the others; the app refuses to start otherwise.
   */
  JWT_ACCESS_SECRET: strongKey(),
  JWT_REFRESH_SECRET: strongKey(),
  LOGIN_CHALLENGE_HMAC_KEY: strongKey(),
  AUTH_LOG_PSEUDONYM_KEY: strongKey(),
  JWT_ISSUER: Joi.string().required(),
  JWT_AUDIENCE: Joi.string().required(),
  LOGIN_EMAIL_CONFIRMATION_ENABLED: Joi.boolean().optional().default(false),
  LOGIN_EMAIL_CONFIRMATION_METHOD: Joi.string()
    .valid('otp', 'magic_link')
    .optional()
    .default('otp'),
  LOGIN_MAGIC_LINK_URL: Joi.string()
    .uri()
    .optional()
    .default('http://localhost:4200/auth/login/confirm'),
  LOGIN_THROTTLE_TTL: Joi.number().optional().default(60000),
  LOGIN_THROTTLE_LIMIT: Joi.number().optional().default(30),
  LOGIN_FAILURE_WINDOW_MS: Joi.number()
    .optional()
    .default(15 * 60 * 1000),
  LOGIN_FAILURE_LIMIT: Joi.number().optional().default(5),
  REFRESH_THROTTLE_TTL: Joi.number().optional().default(60000),
  REFRESH_THROTTLE_LIMIT: Joi.number().optional().default(30),
  /** Exact origin of a trusted frontend on another origin (e.g. https://app.example.com). */
  AUTH_TRUSTED_ORIGIN: Joi.string().uri().allow('').optional(),
  /** Set when the trusted frontend is cross-site: cookies become SameSite=None; Secure. */
  AUTH_COOKIE_CROSS_SITE: Joi.boolean().optional().default(false),

  /**
   * RBAC options
   */
  RBAC_BOOTSTRAP_ADMIN_USER_ID: Joi.string().uuid().allow('').optional(),

  /**
   * User profile options. `API_PUBLIC_URL` is the externally visible base URL
   * used to build `photoUrl`; it must be HTTPS in production.
   */
  API_PUBLIC_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().uri({ scheme: ['https'] }),
    })
    .optional(),
  PROFILE_READ_WINDOW_MS: Joi.number().optional().default(60000),
  PROFILE_READ_OWN_LIMIT: Joi.number().optional().default(120),
  PROFILE_READ_FOREIGN_LIMIT: Joi.number().optional().default(60),
  /** Local filesystem photo storage: single-instance development only. */
  PHOTO_STORAGE_DIR: Joi.string().optional().default('./storage/photos'),

  /**
   * SMTP options (used to deliver confirmation emails)
   */
  SMTP_HOST: Joi.string().allow('').optional(),
  SMTP_PORT: Joi.number().port().optional().default(587),
  SMTP_USER: Joi.string().allow('').optional(),
  SMTP_PASSWORD: Joi.string().allow('').optional(),
  SMTP_FROM: Joi.string().optional().default('no-reply@localhost'),

  /**
   * PostgreSQL database options
   */
  POSTGRES_HOST: Joi.string().hostname().required(),
  POSTGRES_PORT: Joi.number().port().required(),
  POSTGRES_USER: Joi.string().required(),
  POSTGRES_PASSWORD: Joi.string().required(),
  POSTGRES_DB: Joi.string().required(),
  POSTGRES_SYNCHRONIZE: Joi.boolean().optional().default(false),
  POSTGRES_LOGGING: Joi.boolean().optional().default(false),
  POSTGRES_MIGRATIONS_RUN: Joi.boolean().optional().default(false),
}).custom((config: Record<string, unknown>, helpers) => {
  const values = DISTINCT_KEYS.map((key) => config[key]);
  return new Set(values).size === values.length
    ? config
    : helpers.message({
        custom: `${DISTINCT_KEYS.join(', ')} must all be different`,
      });
});
