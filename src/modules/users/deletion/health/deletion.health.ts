import { Injectable } from '@nestjs/common';
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';

import { ConfigService } from '@/core/config/config.service';

import { UserEraserRegistry } from '../services/user-eraser.registry';

const MIN_KEY_BYTES = 32;
const OTHER_KEYS = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'LOGIN_CHALLENGE_HMAC_KEY',
  'EMAIL_CHANGE_HMAC_KEY',
  'AUTH_LOG_PSEUDONYM_KEY',
  'REGISTRATION_SECRET',
] as const;

/**
 * Readiness of the deletion: the challenge HMAC key is at least 32 bytes and
 * differs from the other keys, and every module that stores user data has an
 * eraser (otherwise a deletion could finish while data is left behind).
 */
@Injectable()
export class DeletionReadinessIndicator {
  constructor(
    private readonly indicators: HealthIndicatorService,
    private readonly config: ConfigService,
    private readonly registry: UserEraserRegistry,
  ) {}

  checkKey(key = 'deletion_key'): HealthIndicatorResult {
    const session = this.indicators.check(key);
    const value = this.config.get('DELETION_CHALLENGE_HMAC_KEY');
    if (typeof value !== 'string' || Buffer.byteLength(value) < MIN_KEY_BYTES) {
      return session.down({
        message: 'Deletion HMAC key is missing or too short',
      });
    }
    const reused = OTHER_KEYS.some(
      (name) => (this.config.get(name) as unknown) === value,
    );
    return reused
      ? session.down({ message: 'Deletion HMAC key must be its own key' })
      : session.up();
  }

  checkErasers(key = 'deletion_erasers'): HealthIndicatorResult {
    const session = this.indicators.check(key);
    const missing = this.registry.missing();
    return missing.length === 0
      ? session.up()
      : session.down({ message: `No eraser for: ${missing.join(', ')}` });
  }
}
