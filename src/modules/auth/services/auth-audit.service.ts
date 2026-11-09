import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';

import { ConfigService } from '@/core/config/config.service';

export interface RequestContext {
  ip: string;
  requestId: string;
}

type AuditFields = Record<string, string | number | boolean | undefined>;

/**
 * Structured auth audit log. Callers pass only ids, categories and results:
 * never emails, passwords, OTPs, tokens, cookies or request bodies.
 */
@Injectable()
export class AuthAuditService {
  private readonly logger = new Logger('AuthAudit');

  constructor(private readonly config: ConfigService) {}

  /** One-way identifier (keyed HMAC) that correlates attacks on an address without storing it. */
  pseudonym(email: string): string {
    return createHmac('sha256', this.config.get('AUTH_LOG_PSEUDONYM_KEY'))
      .update(email)
      .digest('hex')
      .slice(0, 24);
  }

  info(event: string, fields: AuditFields = {}): void {
    this.logger.log({ event, ...fields });
  }

  warn(event: string, fields: AuditFields = {}): void {
    this.logger.warn({ event, ...fields });
  }

  error(event: string, fields: AuditFields = {}): void {
    this.logger.error({ event, ...fields });
  }
}
