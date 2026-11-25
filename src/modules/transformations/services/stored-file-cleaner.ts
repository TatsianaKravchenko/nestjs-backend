import { Inject, Injectable } from '@nestjs/common';

import {
  OBJECT_STORAGE,
  type ObjectDeleteResult,
  type ObjectStorage,
} from './object-storage';
import { StagingStore } from './staging-store';

/**
 * Removes everything kept for one key: the staged copy and the permanent
 * object. The permanent delete decides the outcome (`not_found` counts as
 * done); a staged copy that cannot be removed is reported as `unavailable` so
 * the caller retries and the file does not linger. Shared by the retention
 * cleanup, the history retention and the account deletion.
 */
@Injectable()
export class StoredFileCleaner {
  constructor(
    private readonly staging: StagingStore,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async remove(key: string): Promise<ObjectDeleteResult> {
    const stagedGone = await this.staging.remove(key);
    const result = await this.storage.delete(key);
    return stagedGone ? result : 'unavailable';
  }
}
