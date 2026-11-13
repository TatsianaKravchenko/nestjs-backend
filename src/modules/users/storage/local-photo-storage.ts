import { Injectable, Logger } from '@nestjs/common';
import {
  mkdir,
  open,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'fs/promises';
import { randomBytes } from 'crypto';
import { isAbsolute, relative, resolve } from 'path';

import { ConfigService } from '@/core/config/config.service';

import type {
  PhotoDeleteResult,
  PhotoReadResult,
  PhotoStorage,
  StoredObject,
} from './photo-storage';

/**
 * Photos on the local disk under `PHOTO_STORAGE_DIR`. Single-instance
 * development only. A key that would leave the base directory is treated as a
 * missing object.
 */
@Injectable()
export class LocalPhotoStorage implements PhotoStorage {
  private readonly logger = new Logger(LocalPhotoStorage.name);

  constructor(private readonly config: ConfigService) {}

  private base(): string {
    return resolve(this.config.get('PHOTO_STORAGE_DIR') || './storage');
  }

  /** Absolute path of a key, or null when the key would leave the base directory. */
  private pathOf(key: string): string | null {
    const base = this.base();
    const path = resolve(base, key);
    const rel = relative(base, path);
    return !rel || rel.startsWith('..') || isAbsolute(rel) ? null : path;
  }

  /** Writes through a temporary file, so a reader never sees a partial object. */
  async write(key: string, data: Buffer): Promise<void> {
    const path = this.pathOf(key);
    if (!path) throw new Error('invalid_key');
    await mkdir(this.base(), { recursive: true });
    const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temp, data, { flag: 'wx' });
      await rename(temp, path);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      this.logger.error({
        event: 'photo_storage.write_failed',
        category: 'storage',
        errorCode: (error as NodeJS.ErrnoException).code ?? 'unknown',
      });
      throw error;
    }
  }

  async delete(key: string): Promise<PhotoDeleteResult> {
    const path = this.pathOf(key);
    if (!path) return 'not_found';
    try {
      await unlink(path);
      return 'deleted';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'not_found';
      this.logger.error({
        event: 'photo_storage.delete_failed',
        category: 'storage',
        errorCode: code ?? 'unknown',
      });
      return 'unavailable';
    }
  }

  async listOlderThan(cutoff: Date): Promise<StoredObject[]> {
    let names: string[];
    try {
      names = await readdir(this.base());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const found: StoredObject[] = [];
    for (const key of names) {
      const path = this.pathOf(key);
      if (!path) continue;
      const stats = await stat(path).catch(() => null);
      if (stats?.isFile() && stats.mtime < cutoff) {
        found.push({ key, lastModified: stats.mtime });
      }
    }
    return found;
  }

  async read(key: string): Promise<PhotoReadResult> {
    const path = this.pathOf(key);
    if (!path) return { status: 'not_found' };

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
