import { Injectable } from '@nestjs/common';
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';

import { ConfigService } from '@/core/config/config.service';

import { parseCursorKeys } from '../utils/cursor-keys';

/**
 * Readiness: the cursor keys parse, every key has at least 32 bytes and the
 * active key id is one of them. The message never contains key material.
 */
@Injectable()
export class UserListCursorHealthIndicator {
  constructor(
    private readonly indicators: HealthIndicatorService,
    private readonly config: ConfigService,
  ) {}

  check(key = 'user_list_cursor_keys'): HealthIndicatorResult {
    const session = this.indicators.check(key);
    const parsed = parseCursorKeys(
      this.config.get('USER_LIST_CURSOR_ACTIVE_KEY_ID'),
      this.config.get('USER_LIST_CURSOR_HMAC_KEYS'),
    );
    return parsed.ok ? session.up() : session.down({ message: parsed.reason });
  }
}
