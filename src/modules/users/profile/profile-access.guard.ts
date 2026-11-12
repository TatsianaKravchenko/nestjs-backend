import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import {
  invalidSession,
  permissionDenied,
  requestRateLimited,
} from '@/modules/auth/errors/auth.errors';
import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';
import { PolicySnapshotService } from '@/modules/rbac/policy-snapshot.service';
import {
  USERS_PERMISSION,
  USERS_READ_ANY_ACTION,
} from '@/modules/rbac/rbac.constants';
import type { RbacRequest } from '@/modules/rbac/rbac.types';

import { ProfileRateLimiter } from './profile-rate-limiter.service';

/**
 * Runs after `users@read` (RbacGuard) and before the handler, so nothing about
 * the target is looked up yet. For a foreign id it requires `users@read_any`
 * (403 otherwise), then applies the per-actor rate limit (429).
 * Denials are logged with the permission only, never the target id.
 */
@Injectable()
export class ProfileAccessGuard implements CanActivate {
  constructor(
    private readonly policy: PolicySnapshotService,
    private readonly limiter: ProfileRateLimiter,
    private readonly audit: AuthAuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RbacRequest>();
    const actorUserId = request.user?.id;
    if (!actorUserId) throw invalidSession();
    const { userId: target } = request.params as { userId: string };
    const scope = target === actorUserId ? 'self' : 'foreign';
    const base = {
      requestId: String(request.id),
      actorUserId,
      operation: `${context.getClass().name}.${context.getHandler().name}`,
      scope,
    };

    if (scope === 'foreign') {
      // Throws 503 authorization_unavailable if the policy cannot be trusted.
      const allowed = await this.policy.authorize(
        actorUserId,
        USERS_PERMISSION,
        USERS_READ_ANY_ACTION,
      );
      if (!allowed) {
        this.audit.warn('users.access_denied', {
          ...base,
          permission: USERS_PERMISSION,
          action: USERS_READ_ANY_ACTION,
          category: 'permission_denied',
          result: 'denied',
          status: 403,
        });
        throw permissionDenied();
      }
    }

    const decision = this.limiter.hit(actorUserId, scope);
    if (!decision.allowed) {
      this.audit.warn('users.rate_limited', {
        ...base,
        category: 'rate_limited',
        result: 'rate_limited',
        status: 429,
      });
      throw requestRateLimited(decision.retryAfterSeconds);
    }
    return true;
  }
}
