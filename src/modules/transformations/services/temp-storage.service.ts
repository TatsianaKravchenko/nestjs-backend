import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { ConfigService } from '@/core/config/config.service';

const JOB_PREFIX = 'job-';

/**
 * One job's private directory. File names are fixed and chosen by the server:
 * a name sent by the client is never part of a path.
 */
export interface Workspace {
  readonly inputPath: string;
  readonly outputPath: string;
  /** Removes the directory and everything in it. Safe to call repeatedly. */
  dispose(): Promise<void>;
}

/**
 * Private temporary area for intermediate files. The base directory is created
 * with mode 0700 and is never served. Every job gets its own random directory,
 * removed on success, error and timeout; directories left by a crash are swept
 * at startup.
 */
@Injectable()
export class TempStorageService implements OnModuleInit {
  private readonly logger = new Logger(TempStorageService.name);

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.sweep();
    } catch {
      // The area may be unavailable; readiness reports it.
    }
  }

  baseDir(): string {
    return resolve(
      this.config.get('TRANSFORM_TEMP_DIR') ||
        join(tmpdir(), 'mnt-transformations'),
    );
  }

  /** Creates a job directory; throws when the temp area is unavailable. */
  async create(): Promise<Workspace> {
    const base = this.baseDir();
    await mkdir(base, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(base, JOB_PREFIX));
    await chmod(dir, 0o700).catch(() => undefined);

    let disposal: Promise<void> | undefined;
    return {
      inputPath: join(dir, 'input.bin'),
      outputPath: join(dir, 'output.bin'),
      dispose: () => (disposal ??= this.remove(dir)),
    };
  }

  /** True when a job directory can be created and written. */
  async probe(): Promise<boolean> {
    try {
      const workspace = await this.create();
      try {
        await writeFile(workspace.inputPath, 'ok', { flag: 'wx' });
      } finally {
        await workspace.dispose();
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Removes job directories older than the configured age (crash leftovers). */
  async sweep(now = Date.now()): Promise<number> {
    const maxAge = Number(this.config.get('TRANSFORM_TEMP_SWEEP_MAX_AGE_MS'));
    const cutoff =
      now - (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 3600000);
    let names: string[];
    try {
      names = await readdir(this.baseDir());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    let removed = 0;
    for (const name of names) {
      if (!name.startsWith(JOB_PREFIX)) continue;
      const path = join(this.baseDir(), name);
      const stats = await stat(path).catch(() => null);
      if (stats?.isDirectory() && stats.mtimeMs < cutoff) {
        await this.remove(path);
        removed += 1;
      }
    }
    return removed;
  }

  private async remove(dir: string): Promise<void> {
    try {
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    } catch (error) {
      // Only the errno is logged: never the path.
      this.logger.error({
        event: 'transformation.temp_cleanup_failed',
        category: 'temp_storage',
        errorCode: (error as NodeJS.ErrnoException).code ?? 'unknown',
      });
    }
  }
}
