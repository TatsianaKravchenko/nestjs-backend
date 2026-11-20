import { Injectable, Logger } from '@nestjs/common';
import { constants } from 'fs';
import { copyFile, mkdir, unlink } from 'fs/promises';
import { join, resolve } from 'path';

import { ConfigService } from '@/core/config/config.service';

import type { ResultDeleteResult, ResultStore } from './result-store';

const KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
/** Copies waiting for the background write, and objects that were written. */
const AREAS = ['pending', 'objects'] as const;

/**
 * Local-disk `ResultStore` under `TRANSFORM_STORAGE_DIR`. Single-instance
 * development only. A key that is not an opaque token is treated as a missing
 * object, so a key can never leave the base directory.
 */
@Injectable()
export class LocalResultStore implements ResultStore {
  private readonly logger = new Logger(LocalResultStore.name);

  constructor(private readonly config: ConfigService) {}

  private base(): string {
    return resolve(
      this.config.get('TRANSFORM_STORAGE_DIR') || './storage/transformations',
    );
  }

  async retain(key: string, sourcePath: string): Promise<void> {
    if (!KEY_PATTERN.test(key)) throw new Error('invalid_key');
    const dir = join(this.base(), 'pending');
    await mkdir(dir, { recursive: true });
    try {
      await copyFile(sourcePath, join(dir, key), constants.COPYFILE_EXCL);
    } catch (error) {
      this.logger.error({
        event: 'transformation.retain_failed',
        category: 'storage',
        errorCode: (error as NodeJS.ErrnoException).code ?? 'unknown',
      });
      throw error;
    }
  }

  async delete(key: string): Promise<ResultDeleteResult> {
    if (!KEY_PATTERN.test(key)) return 'not_found';
    let deleted = false;
    for (const area of AREAS) {
      try {
        await unlink(join(this.base(), area, key));
        deleted = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') continue;
        this.logger.error({
          event: 'transformation.delete_failed',
          category: 'storage',
          errorCode: code ?? 'unknown',
        });
        return 'unavailable';
      }
    }
    return deleted ? 'deleted' : 'not_found';
  }
}
