import { Injectable, OnModuleInit } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource } from 'typeorm';

import type {
  EraseResult,
  UserEraser,
} from '@/modules/users/deletion/services/user-eraser';
import { UserEraserRegistry } from '@/modules/users/deletion/services/user-eraser.registry';

import { StoredFileCleaner } from './stored-file-cleaner';

/**
 * Account deletion handler. The user's stored files go first (staged copy and
 * permanent object, through the same cleaner as the retention), then the
 * history rows. A missing object counts as deleted; the rows are only removed
 * after every file is gone, so a retry after a storage failure still finds the
 * keys. Repeating it is safe: nothing left means success.
 */
@Injectable()
export class TransformationEraser implements UserEraser, OnModuleInit {
  readonly store = 'transformations';

  constructor(
    private readonly dataSource: DataSource,
    private readonly registry: UserEraserRegistry,
    private readonly cleaner: StoredFileCleaner,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async erase(userId: string): Promise<EraseResult> {
    if (!isUUID(userId)) return { status: 'succeeded' };

    const rows: { storageKey: string }[] = await this.dataSource.query(
      `SELECT stored_file_key AS "storageKey"
         FROM transformations
        WHERE user_id = $1 AND stored_file_key IS NOT NULL`,
      [userId],
    );

    let unavailable = false;
    for (const { storageKey } of rows) {
      if ((await this.cleaner.remove(storageKey)) === 'unavailable') {
        unavailable = true;
      }
    }
    if (unavailable) {
      return { status: 'retryable_failure', code: 'storage_unavailable' };
    }

    await this.dataSource.query(
      `DELETE FROM transformations WHERE user_id = $1`,
      [userId],
    );
    return { status: 'succeeded' };
  }
}
