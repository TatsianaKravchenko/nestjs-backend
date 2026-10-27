import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ThrottlerModule } from '@/core/throttler/throttler.module';
import { UsersModule } from '@/modules/users/users.module';

import { AuthController } from './auth.controller';
import { RegistrationAttempt } from './entities/registration-attempt.entity';
import { MailService } from './mail.service';
import { PasswordService } from './password.service';
import { RegistrationService } from './registration.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([RegistrationAttempt]),
    UsersModule,
    ThrottlerModule,
  ],
  controllers: [AuthController],
  providers: [RegistrationService, PasswordService, MailService],
  exports: [PasswordService],
})
export class AuthModule {}
