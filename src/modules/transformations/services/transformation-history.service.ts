import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  Transformation,
  TransformationStatus,
  TransformationType,
} from '../entities/transformation.entity';
import {
  StorageStatus,
  TransformationObject,
} from '../entities/transformation-object.entity';

export interface AttemptRecord {
  id: string;
  userId: string;
  type: TransformationType;
  sourceFormat: string;
  targetFormat: string;
  status: TransformationStatus;
  inputSize: number;
  outputSize: number | null;
  durationMs: number;
  errorCode: string | null;
  createdAt: Date;
  completedAt: Date;
  /** `save=true`: the key and the state of the stored copy. */
  object?: { key: string; status: StorageStatus };
}

/**
 * The mandatory history write. The row and the optional stored-object row
 * commit together. It throws when the database fails; the caller turns that
 * into a 503 and never returns the result.
 */
@Injectable()
export class TransformationHistoryService {
  constructor(private readonly dataSource: DataSource) {}

  async record(attempt: AttemptRecord): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.insert(Transformation, {
        id: attempt.id,
        userId: attempt.userId,
        type: attempt.type,
        sourceFormat: attempt.sourceFormat,
        targetFormat: attempt.targetFormat,
        status: attempt.status,
        inputSize: attempt.inputSize,
        outputSize: attempt.outputSize,
        durationMs: attempt.durationMs,
        errorCode: attempt.errorCode,
        createdAt: attempt.createdAt,
        completedAt: attempt.completedAt,
      });
      if (attempt.object) {
        await manager.insert(TransformationObject, {
          transformationId: attempt.id,
          storageKey: attempt.object.key,
          storageStatus: attempt.object.status,
        });
      }
    });
  }
}
