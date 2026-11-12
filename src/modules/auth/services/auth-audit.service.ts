import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';

import { ConfigService } from '@/core/config/config.service';

export interface RequestContext {
  ip: string;
  requestId: string;
}

type AuditFields = Record<string, string | number | boolean | undefined>;

/**
 * Defense in depth: a field whose name suggests a secret, credential, raw
 * request data or a full role/permission list is dropped, never logged.
 * `permission` (one server-declared name) stays; `permissions` does not.
 */
const SENSITIVE_FIELD =
  /token|jwt|cookie|authorization|password|passwd|secret|hash|otp|key|body|headers|roles|permissions/i;

export function redact(fields: AuditFields): AuditFields {
  return Object.fromEntries(
    Object.entries(fields).filter(([name]) => !SENSITIVE_FIELD.test(name)),
  );
}

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
    this.logger.log({ event, ...redact(fields) });
  }

  warn(event: string, fields: AuditFields = {}): void {
    this.logger.warn({ event, ...redact(fields) });
  }

  error(event: string, fields: AuditFields = {}): void {
    this.logger.error({ event, ...redact(fields) });
  }
}
