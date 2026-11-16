import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '@/modules/auth/auth.module';
import { CsrfGuard } from '@/modules/auth/guards/csrf.guard';
import { SessionModule } from '@/modules/auth/session.module';
import { RbacModule } from '@/modules/rbac/rbac.module';

import { UserIdFormatGuard } from '../profile/guards/user-id-format.guard';
import { UserProfileModule } from '../profile/user-profile.module';
import { UsersModule } from '../users.module';
import { DeletionStatusController } from './controllers/deletion-status.controller';
import { DeletionController } from './controllers/deletion.controller';
import { DeletionChallenge } from './entities/deletion-challenge.entity';
import { DeletionJob } from './entities/deletion-job.entity';
import {
  DeletionAccessGuard,
  DeletionStatusRateGuard,
} from './guards/deletion-access.guard';
import { DeletionReadinessIndicator } from './health/deletion.health';
import { DeletionChallengeService } from './services/deletion-challenge.service';
import { DeletionLimiter } from './services/deletion-limiter.service';
import { DeletionRequestService } from './services/deletion-request.service';
import { DeletionStatusService } from './services/deletion-status.service';
import { DeletionWorker } from './services/deletion-worker.service';
import { UserEraserRegistry } from './services/user-eraser.registry';
import {
  ChallengeEraser,
  PhotoEraser,
  RoleEraser,
} from './services/user-erasers';

/**
 * Account deletion: the email challenge, the administrator `DELETE`, the
 * status route and the background worker with its eraser registry. A module
 * that stores user data registers a `UserEraser` with `UserEraserRegistry`
 * (exported) and lists its store in `USER_DATA_STORES`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([DeletionJob, DeletionChallenge]),
    UsersModule,
    UserProfileModule,
    SessionModule,
    RbacModule,
    AuthModule,
    TerminusModule,
  ],
  controllers: [DeletionController, DeletionStatusController],
  providers: [
    DeletionChallengeService,
    DeletionRequestService,
    DeletionStatusService,
    DeletionWorker,
    DeletionLimiter,
    DeletionAccessGuard,
    DeletionStatusRateGuard,
    UserIdFormatGuard,
    CsrfGuard,
    UserEraserRegistry,
    PhotoEraser,
    ChallengeEraser,
    RoleEraser,
    DeletionReadinessIndicator,
  ],
  exports: [DeletionReadinessIndicator, UserEraserRegistry, DeletionWorker],
})
export class DeletionModule {}
