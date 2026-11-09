import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { UsersModule } from '@/modules/users/users.module';

import { AccessTokenGuard } from './guards/access-token.guard';
import { AuthAuditService } from './services/auth-audit.service';
import { CookieService } from './services/cookie.service';
import { SessionService } from './services/session.service';
import { TokenService } from './services/token.service';

/**
 * Token verification and the access-token guard. Kept apart from `AuthModule`
 * so that feature modules (e.g. RBAC) can authenticate routes without a cycle.
 */
@Module({
  imports: [UsersModule, JwtModule.register({})],
  providers: [
    AuthAuditService,
    TokenService,
    CookieService,
    SessionService,
    AccessTokenGuard,
  ],
  exports: [
    AuthAuditService,
    TokenService,
    CookieService,
    SessionService,
    AccessTokenGuard,
  ],
})
export class SessionModule {}
