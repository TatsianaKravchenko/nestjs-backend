import { Injectable } from '@nestjs/common';
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';

import { ConfigService } from '@/core/config/config.service';

const MIN_KEY_BYTES = 32;

/** Readiness probe: down unless `EMAIL_CHANGE_HMAC_KEY` is at least 32 bytes. */
@Injectable()
export class EmailChangeKeyHealthIndicator {
  constructor(
    private readonly indicators: HealthIndicatorService,
    private readonly config: ConfigService,
  ) {}

  check(key = 'email_change_key'): HealthIndicatorResult {
    const session = this.indicators.check(key);
    const value = this.config.get('EMAIL_CHANGE_HMAC_KEY');
    return typeof value === 'string' &&
      Buffer.byteLength(value) >= MIN_KEY_BYTES
      ? session.up()
      : session.down({
          message: 'Email change HMAC key is missing or too short',
        });
  }
}
