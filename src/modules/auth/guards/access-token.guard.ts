import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { RbacRequest } from '@/modules/rbac/rbac.types';

import { resolveAdmission } from '../authorization/route-declaration';
import { ACCESS_COOKIE } from '../constants/auth.constants';
import { CookieService } from '../services/cookie.service';
import { SessionService } from '../services/session.service';

/**
 * First guard of the protected chain. Validates the route declaration, then
 * authenticates from the `access_token` cookie and sets `request.user` to the
 * verified id only. Roles are never read from the token: RBAC loads them from
 * server data. A present receipt header skips the check (the handler verifies
 * the receipt).
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly session: SessionService,
    private readonly cookies: CookieService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (resolveAdmission(this.reflector, context) === 'receipt') return true;

    const request = context.switchToHttp().getRequest<RbacRequest>();
    const id = await this.session.authenticate(
      this.cookies.read(request, ACCESS_COOKIE),
      { requestId: String(request.id) },
    );
    request.user = { id };
    return true;
  }
}
