import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import { ConfigService } from '@/core/config/config.service';

import { hasReceipt } from '../authorization/route-declaration';
import { AuthAuditService } from '../services/auth-audit.service';
import { CSRF_HEADER } from '../constants/auth.constants';
import { csrfRejected } from '../errors/auth.errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * State-changing requests that come from another origin must carry exactly the
 * trusted `Origin` and `X-CSRF-Protection: 1`. Same-origin requests and
 * requests without an `Origin` (not sent by a browser cross-origin) pass.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly audit: AuthAuditService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (SAFE_METHODS.has(request.method)) return true;
    // A receipt-guarded request does not use cookie auth: nothing to forge.
    if (hasReceipt(this.reflector, context)) return true;

    const origin = request.headers.origin;
    if (origin === undefined) return true;
    if (origin === `${request.protocol}://${request.headers.host}`) return true; //Same-Origin

    const trusted = this.config.get('AUTH_TRUSTED_ORIGIN'); //front
    const originTrusted = Boolean(trusted) && origin === trusted;
    if (originTrusted && request.headers[CSRF_HEADER] === '1') return true;

    this.audit.warn('csrf.rejected', {
      category: 'csrf_rejected',
      status: 403,
      reason: originTrusted ? 'missing_header' : 'untrusted_origin',
      requestId: String(request.id),
    });
    throw csrfRejected();
  }
}
