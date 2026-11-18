import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import {
  invalidSession,
  requestRateLimited,
} from '@/modules/auth/errors/auth.errors';
import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';
import type { RbacRequest } from '@/modules/rbac/rbac.types';

import { AdminUsersLimiter } from '../services/admin-users-limiter.service';

/**
 * Runs after `users@list` (RbacGuard) and before query validation: 60 requests
 * per actor and 120 per IP in each minute (429). The log has ids only.
 */
@Injectable()
export class AdminUsersRateGuard implements CanActivate {
  constructor(
    private readonly limiter: AdminUsersLimiter,
    private readonly audit: AuthAuditService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RbacRequest>();
    const actorUserId = request.user?.id;
    if (!actorUserId) throw invalidSession();
    const retryAfter = this.limiter.hit(actorUserId, request.ip);
    if (retryAfter > 0) {
      this.audit.warn('users.admin_list.rate_limited', {
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
