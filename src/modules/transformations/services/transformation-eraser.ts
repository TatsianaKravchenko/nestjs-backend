import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource } from 'typeorm';

import type {
  EraseResult,
  UserEraser,
} from '@/modules/users/deletion/services/user-eraser';
import { UserEraserRegistry } from '@/modules/users/deletion/services/user-eraser.registry';

import { RESULT_STORE, type ResultStore } from './result-store';

/**
 * Account deletion handler. The user's stored objects go first, then the
 * history rows. A missing object counts as deleted; the rows are only removed
 * after every object is gone, so a retry after a storage failure still finds
 * the keys. Repeating it is safe: nothing left means success.
 */
@Injectable()
export class TransformationEraser implements UserEraser, OnModuleInit {
  readonly store = 'transformations';

  constructor(
    private readonly dataSource: DataSource,
    private readonly registry: UserEraserRegistry,
    @Inject(RESULT_STORE) private readonly results: ResultStore,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async erase(userId: string): Promise<EraseResult> {
    if (!isUUID(userId)) return { status: 'succeeded' };

    const rows: { storageKey: string }[] = await this.dataSource.query(
      `SELECT o.storage_key AS "storageKey"
         FROM transformation_objects o
         JOIN transformations t ON t.id = o.transformation_id
        WHERE t.user_id = $1`,
      [userId],
    );

    let unavailable = false;
    for (const { storageKey } of rows) {
      if ((await this.results.delete(storageKey)) === 'unavailable') {
        unavailable = true;
      }
    }
    if (unavailable) {
      return { status: 'retryable_failure', code: 'storage_unavailable' };
    }

    // Object rows follow their transformation (ON DELETE CASCADE).
    await this.dataSource.query(
      `DELETE FROM transformations WHERE user_id = $1`,
      [userId],
    );
    return { status: 'succeeded' };
  }
}
