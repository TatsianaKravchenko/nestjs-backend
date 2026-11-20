import Joi from 'joi';

import { Config } from './config.types';

const MIN_KEY_BYTES = 32;
const DISTINCT_KEYS = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'LOGIN_CHALLENGE_HMAC_KEY',
  'AUTH_LOG_PSEUDONYM_KEY',
  'EMAIL_CHANGE_HMAC_KEY',
  'DELETION_CHALLENGE_HMAC_KEY',
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
  /** Profile and photo mutations per user and window (30 per hour). */
  PROFILE_MUTATION_WINDOW_MS: Joi.number().optional().default(3600000),
  PROFILE_MUTATION_LIMIT: Joi.number().optional().default(30),

  /**
   * Email change options. The HMAC key is separate from every other key.
   */
  EMAIL_CHANGE_HMAC_KEY: strongKey(),
  EMAIL_CHANGE_METHOD: Joi.string()
    .valid('otp', 'magic_link')
    .optional()
    .default('otp'),
  EMAIL_CHANGE_MAGIC_LINK_URL: Joi.string()
    .uri()
    .optional()
    .default('http://localhost:4200/profile/email-change/confirm'),
  /** At most this many emails per user and window (5 per hour). */
  EMAIL_CHANGE_WINDOW_MS: Joi.number().optional().default(3600000),
  EMAIL_CHANGE_HOURLY_LIMIT: Joi.number().optional().default(5),

  /**
   * Account deletion options. The HMAC key is separate from every other key.
   */
  DELETION_CHALLENGE_HMAC_KEY: strongKey(),
  DELETION_CONFIRMATION_METHOD: Joi.string()
    .valid('otp', 'magic_link')
    .optional()
    .default('otp'),
  DELETION_MAGIC_LINK_URL: Joi.string()
    .uri()
    .optional()
    .default('http://localhost:4200/profile/deletion/confirm'),
  /** At most this many challenge emails per user and window (5 per hour). */
  DELETION_EMAIL_WINDOW_MS: Joi.number().optional().default(3600000),
  DELETION_EMAIL_HOURLY_LIMIT: Joi.number().optional().default(5),
  /** Deletion status reads per IP and window (60 per minute). */
  DELETION_STATUS_WINDOW_MS: Joi.number().optional().default(60000),
  DELETION_STATUS_LIMIT: Joi.number().optional().default(60),
  DELETION_WORKER_ENABLED: Joi.boolean().optional().default(true),
  DELETION_WORKER_INTERVAL_MS: Joi.number().optional().default(5000),
  DELETION_WORKER_LEASE_SECONDS: Joi.number().min(1).optional().default(300),

  /**
   * Admin user list. Cursor keys are `kid:secret` pairs separated by commas
   * (each secret at least 32 bytes); the active id must be one of them. They
   * are optional at startup: a missing or weak setting fails the readiness
   * probe and the endpoint answers 503.
   */
  USER_LIST_CURSOR_ACTIVE_KEY_ID: Joi.string().allow('').optional(),
  USER_LIST_CURSOR_HMAC_KEYS: Joi.string().allow('').optional(),
  /** Limits per window: 60 per actor, 120 per IP. */
  ADMIN_USERS_LIST_WINDOW_MS: Joi.number().optional().default(60000),
  ADMIN_USERS_LIST_ACTOR_LIMIT: Joi.number().optional().default(60),
  ADMIN_USERS_LIST_IP_LIMIT: Joi.number().optional().default(120),

  /**
   * Storage cleanup worker: deletes objects of replaced or cleared photos and
   * sweeps unreferenced objects older than one hour.
   */
  STORAGE_CLEANUP_WORKER_ENABLED: Joi.boolean().optional().default(true),
  STORAGE_CLEANUP_INTERVAL_MS: Joi.number().optional().default(15000),
  STORAGE_ORPHAN_SWEEP_INTERVAL_MS: Joi.number()
    .optional()
    .default(15 * 60 * 1000),

  /**
   * File transformations. The temp directory is private (created with mode
   * 0700, never served); empty means `<os tmp>/mnt-transformations`. The
   * storage directory is the local stand-in for object storage (task 2.4):
   * single-instance development only. Temp job directories older than the
   * sweep age are removed at startup.
   */
  TRANSFORM_TEMP_DIR: Joi.string().allow('').optional(),
  TRANSFORM_STORAGE_DIR: Joi.string()
    .allow('')
    .optional()
    .default('./storage/transformations'),
  TRANSFORM_TEMP_SWEEP_MAX_AGE_MS: Joi.number()
    .min(60000)
    .optional()
    .default(3600000),

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
