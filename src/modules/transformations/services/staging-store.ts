import { Injectable, Logger } from '@nestjs/common';
import { constants } from 'fs';
import { copyFile, mkdir, unlink } from 'fs/promises';
import { join, resolve } from 'path';

import { ConfigService } from '@/core/config/config.service';

import { STORAGE_KEY_PATTERN } from './object-storage';

/**
 * Internal staging area for `save=true` results: a copy waits here under its
 * random key until the upload worker has moved it to permanent storage. It is
 * a local directory (`<TRANSFORM_STORAGE_DIR>/pending`), never served. A key
 * that is not an opaque token never touches the disk.
 */
@Injectable()
export class StagingStore {
  private readonly logger = new Logger(StagingStore.name);

  constructor(private readonly config: ConfigService) {}

  private dir(): string {
    return join(
      resolve(
        this.config.get('TRANSFORM_STORAGE_DIR') || './storage/transformations',
      ),
      'pending',
    );
  }

  /** Copies a finished file in under `key`. Throws when it fails. */
  async stage(key: string, sourcePath: string): Promise<void> {
    if (!STORAGE_KEY_PATTERN.test(key)) throw new Error('invalid_key');
    await mkdir(this.dir(), { recursive: true });
    await copyFile(sourcePath, join(this.dir(), key), constants.COPYFILE_EXCL);
  }

  /** The path of a staged copy for the upload, or null for an invalid key. */
  pathOf(key: string): string | null {
    return STORAGE_KEY_PATTERN.test(key) ? join(this.dir(), key) : null;
  }

  /** Removes a staged copy. A missing file is fine; returns false on a real failure. */
  async remove(key: string): Promise<boolean> {
    const path = this.pathOf(key);
    if (!path) return true;
    try {
      await unlink(path);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return true;
      this.logger.error({
        event: 'transformation.staging_cleanup_failed',
        category: 'storage',
        errorCode: code ?? 'unknown',
      });
      return false;
    }
  }
}
