import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  invalidSession,
  permissionDenied,
  requestRateLimited,
} from '@/modules/auth/errors/auth.errors';
import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';
import { PolicySnapshotService } from '@/modules/rbac/policy-snapshot.service';
import {
  USERS_PERMISSION,
  USERS_UPDATE_ANY_ACTION,
} from '@/modules/rbac/rbac.constants';
import type { RbacRequest } from '@/modules/rbac/rbac.types';

import { MutationLimiter } from '../services/mutation-limiter.service';

export const SELF_ONLY_KEY = 'users:self-only';
/** The route is only for the own user (email change): admins use PATCH. */
export const SelfOnly = () => SetMetadata(SELF_ONLY_KEY, true);

/**
 * Runs after `users@update` (RbacGuard) and before the handler, so no target
 * lookup happened yet: a foreign id needs `users@update_any` (403), a
 * self-only route refuses a foreign id (403), then the per-user mutation limit
 * applies (429; not for self-only routes).
 */
@Injectable()
export class MutationAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly policy: PolicySnapshotService,
    private readonly limiter: MutationLimiter,
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
    const denied = (action: string) => {
      this.audit.warn('users.access_denied', {
        ...base,
        permission: USERS_PERMISSION,
        action,
        category: 'permission_denied',
        result: 'denied',
        status: 403,
      });
      return permissionDenied();
    };

    const selfOnly = !!this.reflector.getAllAndOverride<boolean | undefined>(
      SELF_ONLY_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (scope === 'foreign') {
      if (selfOnly) throw denied('self_only');
      // Throws 503 authorization_unavailable if the policy cannot be trusted.
      const allowed = await this.policy.authorize(
        actorUserId,
        USERS_PERMISSION,
        USERS_UPDATE_ANY_ACTION,
      );
      if (!allowed) throw denied(USERS_UPDATE_ANY_ACTION);
    }

    // Email-change routes have their own (email) limit.
    if (selfOnly) return true;
    const decision = this.limiter.hitMutation(actorUserId);
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
