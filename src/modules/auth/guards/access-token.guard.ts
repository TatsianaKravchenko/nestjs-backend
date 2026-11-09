import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import type { RbacRequest } from '@/modules/rbac/rbac.types';

import { ACCESS_COOKIE } from '../constants/auth.constants';
import { CookieService } from '../services/cookie.service';
import { SessionService } from '../services/session.service';

/**
 * Authenticates from the `access_token` cookie and sets `request.user` to the
 * verified id only. Roles are never read from the token: RBAC loads them from
 * server data.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly session: SessionService,
    private readonly cookies: CookieService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RbacRequest>();
    const id = await this.session.authenticate(
      this.cookies.read(request, ACCESS_COOKIE),
      { requestId: String(request.id) },
    );
    request.user = { id };
    return true;
  }
}
