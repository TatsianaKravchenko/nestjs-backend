import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  operationName,
  readDeclaration,
  resolveAdmission,
} from '@/modules/auth/authorization/route-declaration';
import {
  invalidSession,
  permissionDenied,
} from '@/modules/auth/errors/auth.errors';
import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';

import { PolicySnapshotService } from './policy-snapshot.service';
import type { RbacRequest } from './rbac.types';

/**
 * Last guard of the protected chain (access token -> CSRF -> RBAC). Checks the
 * server-declared `permission@action` for the authenticated user before the
 * handler runs, so a missing permission is a 403 regardless of whether the
 * target resource exists. The 403 body never names roles. A present receipt
 * header skips the check; the handler verifies the receipt.
 *
 * Every decision is logged with request id, actor, operation, permission,
 * action, policy version and result. No target id (it is added by the handler
 * after read access is granted), no roles, no request data.
 */
@Injectable()
export class RbacGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly policy: PolicySnapshotService,
    private readonly audit: AuthAuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Throws 503 authorization_unavailable for an invalid declaration.
    if (resolveAdmission(this.reflector, context) === 'receipt') return true;

    const { permission: required } = readDeclaration(this.reflector, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<RbacRequest>();
    const userId = request.user?.id;
    if (!required || !userId) {
      // `required` is guaranteed by resolveAdmission; no user means no session.
      throw invalidSession();
    }

    const allowed = await this.policy.authorize(
      userId,
      required.permission,
      required.action,
    );
    const decision = {
      requestId: String(request.id),
      actorUserId: userId,
      operation: operationName(context),
      permission: required.permission,
      action: required.action,
      policyVersion: this.policy.version ?? undefined,
    };
    if (!allowed) {
      this.audit.warn('rbac.access_denied', {
        ...decision,
        category: 'permission_denied',
        result: 'denied',
        status: 403,
      });
      throw permissionDenied();
    }
    this.audit.info('rbac.access_granted', { ...decision, result: 'allowed' });
    return true;
  }
}
