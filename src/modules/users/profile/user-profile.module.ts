import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { AuthModule } from '@/modules/auth/auth.module';
import { SessionModule } from '@/modules/auth/session.module';
import { CsrfGuard } from '@/modules/auth/guards/csrf.guard';
import { RbacModule } from '@/modules/rbac/rbac.module';

import { PHOTO_STORAGE } from '../storage/photo-storage';
import { LocalPhotoStorage } from '../storage/local-photo-storage';
import { UsersModule } from '../users.module';
import { ProfileAccessGuard } from './guards/profile-access.guard';
import { ProfileRateLimiter } from './services/profile-rate-limiter.service';
import { UserIdFormatGuard } from './guards/user-id-format.guard';
import { UserProfileService } from './services/user-profile.service';
import { EmailChangeKeyHealthIndicator } from './health/email-change-key.health';
import { EmailChangeService } from './services/email-change.service';
import { MutationAccessGuard } from './guards/mutation-access.guard';
import { MutationLimiter } from './services/mutation-limiter.service';
import { UserPhotoService } from './services/user-photo.service';
import { UserUpdateService } from './services/user-update.service';
import { UsersMutationController } from './controllers/users-mutation.controller';
import { ImageNormalizer } from '../photo/image-normalizer';
import { StorageCleanupWorker } from '../storage/storage-cleanup.worker';
import { UsersController } from './controllers/users.controller';

/**
 * Profile read and update endpoints. A separate module from `UsersModule` because RBAC
 * and the session depend on `UsersModule`; importing them there would cycle.
 */
@Module({
  imports: [UsersModule, SessionModule, RbacModule, AuthModule, TerminusModule],
  controllers: [UsersController, UsersMutationController],
  providers: [
    UserProfileService,
    ProfileRateLimiter,
    ProfileAccessGuard,
    MutationAccessGuard,
    MutationLimiter,
    UserUpdateService,
    EmailChangeService,
    UserPhotoService,
    ImageNormalizer,
    StorageCleanupWorker,
    EmailChangeKeyHealthIndicator,
    UserIdFormatGuard,
    CsrfGuard,
    { provide: PHOTO_STORAGE, useClass: LocalPhotoStorage },
  ],
  exports: [EmailChangeKeyHealthIndicator, StorageCleanupWorker, PHOTO_STORAGE],
})
export class UserProfileModule {}
