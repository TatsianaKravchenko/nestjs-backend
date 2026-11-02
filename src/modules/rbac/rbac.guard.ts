import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PolicySnapshotService } from './policy-snapshot.service';
import { REQUIRED_PERMISSION_KEY } from './rbac.constants';
import type { RbacRequest, RequiredPermission } from './rbac.types';

/**
 * Deny-by-default check for routes marked with `@RequirePermission`.
 * Runs before the handler, so a missing permission is a 403 regardless of
 * whether the target resource exists. The 403 body never names roles.
 */
@Injectable()
export class RbacGuard implements CanActivate {
  private readonly logger = new Logger(RbacGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly policy: PolicySnapshotService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<
      RequiredPermission | undefined
    >(REQUIRED_PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    const request = context.switchToHttp().getRequest<RbacRequest>();

    if (!required) {
      // A guard without a declared permission is a wiring mistake: deny.
      this.logger.error({
        event: 'rbac.guard.misconfigured',
        route: `${request.method} ${request.url.split('?')[0]}`,
      });
      throw new ForbiddenException();
    }

    const userId = request.user?.id;
    if (!userId) {
      throw new UnauthorizedException();
    }

    const allowed = await this.policy.authorize(
      userId,
      required.permission,
      required.action,
    );
    if (!allowed) {
      this.logger.warn({
        event: 'rbac.access_denied',
        actorId: userId,
        permission: required.permission,
        action: required.action,
        operationId: String(request.id),
        status: 403,
      });
      throw new ForbiddenException();
    }
    return true;
  }
}
