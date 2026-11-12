import { Module } from '@nestjs/common';

import { SessionModule } from '@/modules/auth/session.module';
import { CsrfGuard } from '@/modules/auth/guards/csrf.guard';
import { RbacModule } from '@/modules/rbac/rbac.module';

import { PHOTO_STORAGE } from '../storage/photo-storage';
import { LocalPhotoStorage } from '../storage/local-photo-storage';
import { UsersModule } from '../users.module';
import { ProfileAccessGuard } from './profile-access.guard';
import { ProfileRateLimiter } from './profile-rate-limiter.service';
import { UserIdFormatGuard } from './user-id-format.guard';
import { UserProfileService } from './user-profile.service';
import { UsersController } from './users.controller';

/**
 * Profile read endpoints. A separate module from `UsersModule` because RBAC
 * and the session depend on `UsersModule`; importing them there would cycle.
 */
@Module({
  imports: [UsersModule, SessionModule, RbacModule],
  controllers: [UsersController],
  providers: [
    UserProfileService,
    ProfileRateLimiter,
    ProfileAccessGuard,
    UserIdFormatGuard,
    CsrfGuard,
    { provide: PHOTO_STORAGE, useClass: LocalPhotoStorage },
  ],
})
export class UserProfileModule {}
