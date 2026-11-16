import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AllowReceipt } from '@/modules/auth/decorators/receipt.decorator';
import {
  invalidSession,
  permissionDenied,
  requestRateLimited,
  selfConfirmationRequired,
} from '@/modules/auth/errors/auth.errors';
import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';
import { PolicySnapshotService } from '@/modules/rbac/policy-snapshot.service';
import { RequirePermission } from '@/modules/rbac/rbac.decorators';
import {
  USERS_DELETE_ACTION,
  USERS_DELETE_ANY_ACTION,
  USERS_PERMISSION,
} from '@/modules/rbac/rbac.constants';
import type { RbacRequest } from '@/modules/rbac/rbac.types';

import { DeletionLimiter } from '../services/deletion-limiter.service';
import { RECEIPT_HEADER } from '../utils/deletion-support';

export type DeletionScope = 'self' | 'admin' | 'status';
const SCOPE_KEY = 'users:deletion-scope';

/**
 * Declares a deletion route: `users@delete` through the standard chain (access
 * token, CSRF, RBAC), then the scope check of `DeletionAccessGuard`. The
 * `status` scope also accepts the `Deletion-Receipt` header instead of a session.
 */
export const DeletionRoute = (scope: DeletionScope) =>
  applyDecorators(
    RequirePermission(USERS_PERMISSION, USERS_DELETE_ACTION),
    ...(scope === 'status' ? [AllowReceipt(RECEIPT_HEADER)] : []),
    SetMetadata(SCOPE_KEY, scope),
    UseGuards(DeletionAccessGuard),
  );

/**
 * Runs after `users@delete` (RbacGuard), before any target lookup:
 * - `self`: only the own id (a foreign id is 403);
 * - `admin`: `users@delete_any` first (403), then the own id is refused with
 *   `self_confirmation_required` (403): own accounts need the email challenge;
 * - `status`: with a receipt the handler decides; without one the caller needs
 *   `users@delete_any`.
 * The log names the event and the result only.
 */
@Injectable()
export class DeletionAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly policy: PolicySnapshotService,
    private readonly audit: AuthAuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RbacRequest>();
    const scope = this.reflector.getAllAndOverride<DeletionScope>(SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const receipt = request.headers[RECEIPT_HEADER];
    if (scope === 'status' && typeof receipt === 'string' && receipt) {
      return true;
    }

    const actorUserId = request.user?.id;
    if (!actorUserId) throw invalidSession();
    const { userId: target } = request.params as { userId: string };
    const foreign = target !== actorUserId;

    if (scope === 'self') {
      if (foreign) throw this.denied('foreign_target');
      return true;
    }
    // Throws 503 authorization_unavailable if the policy cannot be trusted.
    const allowed = await this.policy.authorize(
      actorUserId,
      USERS_PERMISSION,
      USERS_DELETE_ANY_ACTION,
    );
    if (!allowed) throw this.denied(USERS_DELETE_ANY_ACTION);
    if (scope === 'admin' && !foreign) {
      this.audit.warn('users.deletion.access_denied', {
        result: 'self_confirmation_required',
        status: 403,
      });
      throw selfConfirmationRequired();
    }
    return true;
  }

  private denied(result: string) {
    this.audit.warn('users.deletion.access_denied', { result, status: 403 });
    return permissionDenied();
  }
}

/** 60 status reads per IP and minute, before the session or receipt is looked at. */
@Injectable()
export class DeletionStatusRateGuard implements CanActivate {
  constructor(
    private readonly limiter: DeletionLimiter,
    private readonly audit: AuthAuditService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ ip: string }>();
    const retryAfter = this.limiter.hitStatus(request.ip);
    if (retryAfter > 0) {
      this.audit.warn('users.deletion.rate_limited', {
        result: 'rate_limited',
        status: 429,
      });
      throw requestRateLimited(retryAfter);
    }
    return true;
  }
}
