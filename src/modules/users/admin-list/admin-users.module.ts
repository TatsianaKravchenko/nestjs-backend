import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { AuthModule } from '@/modules/auth/auth.module';
import { CsrfGuard } from '@/modules/auth/guards/csrf.guard';
import { SessionModule } from '@/modules/auth/session.module';
import { RbacModule } from '@/modules/rbac/rbac.module';

import { UsersModule } from '../users.module';
import { AdminUsersController } from './controllers/admin-users.controller';
import { AdminUsersRateGuard } from './guards/admin-users-rate.guard';
import { UserListCursorHealthIndicator } from './health/user-list-cursor.health';
import { AdminUsersLimiter } from './services/admin-users-limiter.service';
import { AdminUsersService } from './services/admin-users.service';
import { UserListCursorService } from './services/user-list-cursor.service';

/** `GET /admin/users`: administrator user list with signed keyset pagination. */
@Module({
  imports: [UsersModule, SessionModule, RbacModule, AuthModule, TerminusModule],
  controllers: [AdminUsersController],
  providers: [
    AdminUsersService,
    AdminUsersLimiter,
    AdminUsersRateGuard,
    UserListCursorService,
    UserListCursorHealthIndicator,
    CsrfGuard,
  ],
  exports: [UserListCursorHealthIndicator],
})
export class AdminUsersModule {}
