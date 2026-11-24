import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '@/modules/auth/auth.module';
import { CsrfGuard } from '@/modules/auth/guards/csrf.guard';
import { SessionModule } from '@/modules/auth/session.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { DeletionModule } from '@/modules/users/deletion/deletion.module';

import { AdminTransformationHistoryController } from './controllers/admin-transformation-history.controller';
import { TransformationHistoryController } from './controllers/transformation-history.controller';
import { Transformation } from './entities/transformation.entity';
import { TransformationObject } from './entities/transformation-object.entity';
import { HistoryRateGuard } from './guards/history-rate.guard';
import { TransformationsReadinessIndicator } from './health/transformations.health';
import { HistoryQueryPipe } from './pipes/history-query.pipe';
import { ConverterRegistry } from './services/converter.registry';
import { HistoryLimiter } from './services/history-limiter.service';
import { HistoryRetentionWorker } from './services/history-retention.worker';
import { LocalResultStore } from './services/local-result-store';
import { RESULT_STORE } from './services/result-store';
import { TempStorageService } from './services/temp-storage.service';
import { TransformationAuditService } from './services/transformation-audit.service';
import { TransformationEraser } from './services/transformation-eraser';
import { TransformationHistoryReader } from './services/transformation-history-reader.service';
import { TransformationHistoryService } from './services/transformation-history.service';
import { TransformationService } from './services/transformation.service';
import { TransformationsPolicyService } from './services/transformations-policy.service';

/**
 * Shared foundation of the file transformations: the converter registry, the
 * pipeline service, the history, the `transformations` permission setup and the
 * user-deletion handler, and the history read
 * side (`GET /transformations/history`, the administrator route, retention). Format modules (text, images) import this module and
 * register their converters with `ConverterRegistry` on module init.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Transformation, TransformationObject]),
    RbacModule,
    SessionModule,
    AuthModule,
    DeletionModule,
    TerminusModule,
  ],
  controllers: [
    TransformationHistoryController,
    AdminTransformationHistoryController,
  ],
  providers: [
    ConverterRegistry,
    TempStorageService,
    TransformationHistoryService,
    TransformationHistoryReader,
    HistoryLimiter,
    HistoryRateGuard,
    HistoryQueryPipe,
    HistoryRetentionWorker,
    CsrfGuard,
    TransformationAuditService,
    TransformationService,
    TransformationsPolicyService,
    TransformationEraser,
    TransformationsReadinessIndicator,
    { provide: RESULT_STORE, useClass: LocalResultStore },
  ],
  exports: [
    ConverterRegistry,
    TransformationService,
    TransformationsReadinessIndicator,
  ],
})
export class TransformationsModule {}
