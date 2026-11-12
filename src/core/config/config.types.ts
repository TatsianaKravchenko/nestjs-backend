export interface Config {
  PORT: number;
  NODE_ENV: 'development' | 'production';

  /**
   * Cookie secret
   */
  COOKIE_SECRET: string;

  /**
   * Health check options
   */
  HEALTH_CHECK_ENABLED?: boolean;

  /**
   * Throttler options
   */
  THROTTLE_GLOBAL_TTL?: number;
  THROTTLE_GLOBAL_LIMIT?: number;

  /**
   * Registration options
   */
  REGISTRATION_CONFIRMATION_ENABLED?: boolean;
  REGISTRATION_CONFIRMATION_METHOD?: 'otp' | 'magic_link';
  REGISTRATION_SECRET: string;
  REGISTRATION_MAGIC_LINK_URL?: string;
  REGISTRATION_THROTTLE_TTL?: number;
  REGISTRATION_THROTTLE_LIMIT?: number;

  /**
   * Authentication options
   */
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  LOGIN_CHALLENGE_HMAC_KEY: string;
  AUTH_LOG_PSEUDONYM_KEY: string;
  LOGIN_EMAIL_CONFIRMATION_ENABLED?: boolean;
  LOGIN_EMAIL_CONFIRMATION_METHOD?: 'otp' | 'magic_link';
  LOGIN_MAGIC_LINK_URL?: string;
  LOGIN_THROTTLE_TTL?: number;
  LOGIN_THROTTLE_LIMIT?: number;
  LOGIN_FAILURE_WINDOW_MS?: number;
  LOGIN_FAILURE_LIMIT?: number;
  REFRESH_THROTTLE_TTL?: number;
  REFRESH_THROTTLE_LIMIT?: number;
  AUTH_TRUSTED_ORIGIN?: string;
  AUTH_COOKIE_CROSS_SITE?: boolean;

  /**
   * RBAC options
   */
  RBAC_BOOTSTRAP_ADMIN_USER_ID?: string;

  /**
   * User profile options
   */
  API_PUBLIC_URL?: string;
  PROFILE_READ_WINDOW_MS?: number;
  PROFILE_READ_OWN_LIMIT?: number;
  PROFILE_READ_FOREIGN_LIMIT?: number;
  PHOTO_STORAGE_DIR?: string;

  /**
   * SMTP options (used to deliver confirmation emails)
   */
  SMTP_HOST?: string;
  SMTP_PORT?: number;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM?: string;

  /**
   * PostgreSQL database options
   */
  POSTGRES_HOST: string;
  POSTGRES_PORT: number;
  POSTGRES_USER: string;
  POSTGRES_PASSWORD: string;
  POSTGRES_DB: string;
  POSTGRES_SYNCHRONIZE?: boolean;
  POSTGRES_LOGGING?: boolean;
  POSTGRES_MIGRATIONS_RUN?: boolean;
}
