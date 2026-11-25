import { Injectable, Logger } from '@nestjs/common';
import { createReadStream } from 'fs';
import { copyFile, mkdir, rename, stat, unlink } from 'fs/promises';
import { join, resolve } from 'path';

import { ConfigService } from '@/core/config/config.service';

import {
  ObjectNotFoundError,
  type ObjectDeleteResult,
  type ObjectStorage,
  StoragePermanentError,
  StorageUnavailableError,
  STORAGE_KEY_PATTERN,
  type StoredObject,
} from './object-storage';

/**
 * Local-disk `ObjectStorage` under `<TRANSFORM_STORAGE_DIR>/objects`. For
 * single-instance development. A key that is not an opaque token never touches
 * the disk, so a key cannot leave the base directory. A write goes to a
 * temporary name first and is renamed, so a reader never sees half a file.
 */
@Injectable()
export class LocalObjectStorage implements ObjectStorage {
  private readonly logger = new Logger(LocalObjectStorage.name);

  constructor(private readonly config: ConfigService) {}

  private dir(): string {
    return join(
      resolve(
        this.config.get('TRANSFORM_STORAGE_DIR') || './storage/transformations',
      ),
      'objects',
    );
  }

  async save(key: string, sourcePath: string): Promise<void> {
    if (!STORAGE_KEY_PATTERN.test(key)) throw new StoragePermanentError('key');
    const target = join(this.dir(), key);
    const partial = `${target}.part`;
    try {
      await mkdir(this.dir(), { recursive: true });
      await copyFile(sourcePath, partial);
      await rename(partial, target);
    } catch (error) {
      await unlink(partial).catch(() => undefined);
      this.fail('save', error);
      throw new StorageUnavailableError();
    }
  }

  async read(key: string): Promise<StoredObject> {
    if (!STORAGE_KEY_PATTERN.test(key)) throw new ObjectNotFoundError();
    const path = join(this.dir(), key);
    try {
      const { size } = await stat(path);
      return { stream: createReadStream(path), size };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new ObjectNotFoundError();
      }
      this.fail('read', error);
      throw new StorageUnavailableError();
    }
  }

  async delete(key: string): Promise<ObjectDeleteResult> {
    if (!STORAGE_KEY_PATTERN.test(key)) return 'not_found';
    try {
      await unlink(join(this.dir(), key));
      return 'deleted';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'not_found';
      this.fail('delete', error);
      return 'unavailable';
    }
  }

  /** Only the errno is logged: never the path or the key. */
  private fail(operation: string, error: unknown): void {
    this.logger.error({
      event: 'transformation.storage_failed',
      category: 'storage',
      operation,
      errorCode: (error as NodeJS.ErrnoException).code ?? 'unknown',
    });
  }
}
