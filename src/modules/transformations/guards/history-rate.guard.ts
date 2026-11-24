import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import {
  invalidSession,
  requestRateLimited,
} from '@/modules/auth/errors/auth.errors';
import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';
import type { RbacRequest } from '@/modules/rbac/rbac.types';

import { HistoryLimiter } from '../services/history-limiter.service';

/**
 * Runs after the `transformations@history[_any]` check (RbacGuard) and before
 * query validation: 60 requests per user per minute (429). The log has ids only.
 */
@Injectable()
export class HistoryRateGuard implements CanActivate {
  constructor(
    private readonly limiter: HistoryLimiter,
    private readonly audit: AuthAuditService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RbacRequest>();
    const actorUserId = request.user?.id;
    if (!actorUserId) throw invalidSession();
    const retryAfter = this.limiter.hit(actorUserId);
    if (retryAfter > 0) {
      this.audit.warn('transformations.history.rate_limited', {
        requestId: String(request.id),
        actorUserId,
        result: 'rate_limited',
        status: 429,
      });
      throw requestRateLimited(retryAfter);
    }
    return true;
  }
}
