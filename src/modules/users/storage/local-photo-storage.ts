import { Injectable, Logger } from '@nestjs/common';
import { open } from 'fs/promises';
import { isAbsolute, relative, resolve } from 'path';

import { ConfigService } from '@/core/config/config.service';

import type { PhotoReadResult, PhotoStorage } from './photo-storage';

/**
 * Photos on the local disk under `PHOTO_STORAGE_DIR`. Single-instance
 * development only. A key that would leave the base directory is treated as a
 * missing object.
 */
@Injectable()
export class LocalPhotoStorage implements PhotoStorage {
  private readonly logger = new Logger(LocalPhotoStorage.name);

  constructor(private readonly config: ConfigService) {}

  async read(key: string): Promise<PhotoReadResult> {
    const base = resolve(this.config.get('PHOTO_STORAGE_DIR') || './storage');
    const path = resolve(base, key);
    const rel = relative(base, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      return { status: 'not_found' };
    }

    try {
      const handle = await open(path, 'r');
      const stats = await handle.stat();
      if (!stats.isFile()) {
        await handle.close();
        return { status: 'not_found' };
      }
      return { status: 'found', stream: handle.createReadStream() };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { status: 'not_found' };
      }
      this.logger.error({
        event: 'photo_storage.read_failed',
        category: 'storage',
        errorCode: code ?? 'unknown',
      });
      return { status: 'unavailable' };
    }
  }
}
