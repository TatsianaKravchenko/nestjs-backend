import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RbacModule } from '@/modules/rbac/rbac.module';
import { DeletionModule } from '@/modules/users/deletion/deletion.module';

import { Transformation } from './entities/transformation.entity';
import { TransformationObject } from './entities/transformation-object.entity';
import { TransformationsReadinessIndicator } from './health/transformations.health';
import { ConverterRegistry } from './services/converter.registry';
import { LocalResultStore } from './services/local-result-store';
import { RESULT_STORE } from './services/result-store';
import { TempStorageService } from './services/temp-storage.service';
import { TransformationAuditService } from './services/transformation-audit.service';
import { TransformationEraser } from './services/transformation-eraser';
import { TransformationHistoryService } from './services/transformation-history.service';
import { TransformationService } from './services/transformation.service';
import { TransformationsPolicyService } from './services/transformations-policy.service';

/**
 * Shared foundation of the file transformations: the converter registry, the
 * pipeline service, the history, the `transformations` permission setup and the
 * user-deletion handler. Format modules (text, images) import this module and
 * register their converters with `ConverterRegistry` on module init.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Transformation, TransformationObject]),
    RbacModule,
    DeletionModule,
    TerminusModule,
  ],
  providers: [
    ConverterRegistry,
    TempStorageService,
    TransformationHistoryService,
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
