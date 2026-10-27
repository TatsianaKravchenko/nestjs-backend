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
