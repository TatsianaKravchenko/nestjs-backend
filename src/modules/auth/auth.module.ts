import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ThrottlerModule } from '@/core/throttler/throttler.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { UsersModule } from '@/modules/users/users.module';

import { RouteDeclarationValidator } from './authorization/route-declaration.validator';
import { AuthController } from './controllers/auth.controller';
import { CsrfGuard } from './guards/csrf.guard';
import { LoginAttempt } from './entities/login-attempt.entity';
import { RegistrationAttempt } from './entities/registration-attempt.entity';
import { LoginController } from './controllers/login.controller';
import { LoginFailureLimiter } from './services/login-failure-limiter.service';
import { LoginService } from './services/login.service';
import { MailService } from './services/mail.service';
import { PasswordService } from './services/password.service';
import { RegistrationService } from './services/registration.service';
import { SessionModule } from './session.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([RegistrationAttempt, LoginAttempt]),
    UsersModule,
    RbacModule,
    SessionModule,
    ThrottlerModule,
    DiscoveryModule,
  ],
  controllers: [AuthController, LoginController],
  providers: [
    RegistrationService,
    LoginService,
    LoginFailureLimiter,
    CsrfGuard,
    RouteDeclarationValidator,
    PasswordService,
    MailService,
  ],
  exports: [PasswordService, SessionModule],
})
export class AuthModule {}
