import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { stat } from 'fs/promises';
import { performance } from 'perf_hooks';
import { DataSource } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';

import {
  OBJECT_STORAGE,
  type ObjectStorage,
  StoragePermanentError,
} from './object-storage';
import { StagingStore } from './staging-store';
import { StoredFileCleaner } from './stored-file-cleaner';
import { TransformationAuditService } from './transformation-audit.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Upper bound of batches per cleanup run, so one run cannot hold the worker forever. */
const MAX_BATCHES_PER_RUN = 100;

interface PendingRow {
  id: string;
  userId: string;
  key: string;
  outputSize: string | null;
  completedAt: Date;
}

interface ExpiredRow {
  id: string;
  userId: string;
  key: string;
  outputSize: string | null;
}

export interface UploadRunResult {
  uploaded: number;
  failed: number;
  /** Left `pending` for the next run (storage unavailable). */
  retried: number;
}

export interface ExpiryRunResult {
  deleted: number;
  /** Kept for the next run because the stored file could not be deleted. */
  skipped: number;
}

/**
 * Background work for saved results, polled from the database so it survives
 * restarts and works on several instances.
 *
 * Upload: every `pending` row is uploaded from the staging area to permanent
 * storage under its pre-assigned key. The upload is idempotent (same key,
 * same bytes), so a crash or a second instance doing the same row is harmless;
 * the status change is conditional on the row still being `pending`. Success
 * makes the row `available` for the retention period and removes the staged
 * copy. A missing staged copy, a permanent refusal or a copy pending longer
 * than `TRANSFORM_UPLOAD_MAX_AGE_MS` makes it `error` with a safe code; a
 * temporary storage failure leaves it `pending` for the next run.
 *
 * Retention: `available` rows past `stored_file_until` lose their file first
 * (`not_found` counts as done), then their storage fields are cleared. When the
 * storage is unavailable the row keeps its key, so the next run retries.
 */
@Injectable()
export class StoredFileWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StoredFileWorker.name);
  private timers: NodeJS.Timeout[] = [];
  private running = { upload: false, cleanup: false };

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly staging: StagingStore,
    private readonly cleaner: StoredFileCleaner,
    private readonly audit: TransformationAuditService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  onModuleInit(): void {
    if (
      String(this.config.get('TRANSFORM_UPLOAD_WORKER_ENABLED')) !== 'false'
    ) {
      this.schedule(
        'upload',
        () => this.uploadPending(),
        Number(this.config.get('TRANSFORM_UPLOAD_INTERVAL_MS')),
      );
    }
    if (
      String(this.config.get('TRANSFORM_STORED_FILE_CLEANUP_ENABLED')) !==
      'false'
    ) {
      this.schedule(
        'cleanup',
        () => this.cleanupExpired(),
        Number(this.config.get('TRANSFORM_STORED_FILE_CLEANUP_INTERVAL_MS')),
      );
    }
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  private schedule(
    name: 'upload' | 'cleanup',
    work: () => Promise<unknown>,
    intervalMs: number,
  ): void {
    const timer = setInterval(() => void this.guarded(name, work), intervalMs);
    timer.unref();
    this.timers.push(timer);
  }

  private async guarded(
    name: 'upload' | 'cleanup',
    work: () => Promise<unknown>,
  ): Promise<void> {
    if (this.running[name]) return;
    this.running[name] = true;
    try {
      await work();
    } catch {
      // Only a code: a database error message may hold SQL or values.
      this.logger.error({
        event: `transformation.stored_file.${name}_run_failed`,
        category: 'storage',
      });
    } finally {
      this.running[name] = false;
    }
  }

  /** One pass over the `pending` rows (oldest first, one batch). */
  async uploadPending(now = new Date()): Promise<UploadRunResult> {
    const batch = Number(this.config.get('TRANSFORM_UPLOAD_BATCH_SIZE'));
    const maxAge = Number(this.config.get('TRANSFORM_UPLOAD_MAX_AGE_MS'));
    const rows: PendingRow[] = await this.dataSource.query(
      `SELECT id, user_id AS "userId", stored_file_key AS "key",
              output_size AS "outputSize", completed_at AS "completedAt"
         FROM transformations
        WHERE storage_status = 'pending'
        ORDER BY completed_at ASC, id ASC
        LIMIT $1`,
      [batch],
    );

    const total: UploadRunResult = { uploaded: 0, failed: 0, retried: 0 };
    for (const row of rows) {
      const outcome = await this.uploadOne(row, now, maxAge);
      if (outcome === 'uploaded') total.uploaded += 1;
      else if (outcome === 'failed') total.failed += 1;
      else total.retried += 1;
    }
    return total;
  }

  private async uploadOne(
    row: PendingRow,
    now: Date,
    maxAgeMs: number,
  ): Promise<'uploaded' | 'failed' | 'retried'> {
    const started = performance.now();
    const size = row.outputSize === null ? undefined : Number(row.outputSize);
    const done = (
      outcome: 'success' | 'error' | 'unavailable',
      errorCode?: string,
    ): void =>
      this.audit.storage(
        outcome === 'success' ? 'log' : outcome === 'error' ? 'error' : 'warn',
        'transformation.stored_file.save',
        {
          userId: row.userId,
          transformationId: row.id,
          action: 'save',
          ...(size === undefined ? {} : { size }),
          outcome,
          ...(errorCode ? { errorCode } : {}),
          durationMs: Math.round(performance.now() - started),
        },
      );

    const path = this.staging.pathOf(row.key);
    const timedOut =
      now.getTime() - new Date(row.completedAt).getTime() > maxAgeMs;
    const staged =
      path !== null &&
      (await stat(path).then(
        (s) => s.isFile(),
        () => false,
      ));
    if (timedOut || !staged || path === null) {
      const code = timedOut ? 'upload_timeout' : 'staging_missing';
      const changed = await this.markError(row.id, code);
      if (changed) {
        await this.staging.remove(row.key);
        done('error', code);
        return 'failed';
      }
      return 'retried';
    }

    try {
      await this.storage.save(row.key, path);
    } catch (error) {
      if (error instanceof StoragePermanentError) {
        if (await this.markError(row.id, error.code)) {
          await this.staging.remove(row.key);
          done('error', error.code);
          return 'failed';
        }
        return 'retried';
      }
      done('unavailable', 'storage_unavailable');
      return 'retried';
    }

    const days = Number(
      this.config.get('TRANSFORM_STORED_FILE_RETENTION_DAYS'),
    );
    const until = new Date(now.getTime() + days * DAY_MS);
    const updated: unknown[] = await this.dataSource.query(
      `UPDATE transformations
          SET storage_status = 'available', stored_file_until = $2
        WHERE id = $1 AND storage_status = 'pending'
        RETURNING id`,
      [row.id, until],
    );
    // Another instance finished (or the row was deleted): nothing more to do.
    if (updated.length > 0) {
      await this.staging.remove(row.key);
      done('success');
    }
    return 'uploaded';
  }

  /** `pending` -> `error`; false when the row is no longer `pending`. */
  private async markError(id: string, code: string): Promise<boolean> {
    const rows: unknown[] = await this.dataSource.query(
      `UPDATE transformations
          SET storage_status = 'error', storage_error_code = $2
        WHERE id = $1 AND storage_status = 'pending'
        RETURNING id`,
      [id, code],
    );
    return rows.length > 0;
  }

  /** Deletes expired stored files, batch by batch. */
  async cleanupExpired(now = new Date()): Promise<ExpiryRunResult> {
    const batchSize = Number(
      this.config.get('TRANSFORM_STORED_FILE_CLEANUP_BATCH_SIZE'),
    );
    const total: ExpiryRunResult = { deleted: 0, skipped: 0 };

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      const rows: ExpiredRow[] = await this.dataSource.query(
        `SELECT id, user_id AS "userId", stored_file_key AS "key",
                output_size AS "outputSize"
           FROM transformations
          WHERE storage_status = 'available' AND stored_file_until < $1
          ORDER BY stored_file_until ASC, id ASC
          LIMIT $2`,
        [now, batchSize],
      );
      if (rows.length === 0) break;

      let removed = 0;
      for (const row of rows) {
        if (await this.expire(row)) removed += 1;
        else total.skipped += 1;
      }
      total.deleted += removed;
      // Nothing removed: the same rows would come back; leave them for the next run.
      if (removed === 0 || rows.length < batchSize) break;
    }
    return total;
  }

  private async expire(row: ExpiredRow): Promise<boolean> {
    const started = performance.now();
    const audit = (
      outcome: 'success' | 'unavailable',
      level: 'log' | 'warn',
    ): void =>
      this.audit.storage(level, 'transformation.stored_file.delete', {
        userId: row.userId,
        transformationId: row.id,
        action: 'delete',
        ...(row.outputSize === null ? {} : { size: Number(row.outputSize) }),
        outcome,
        durationMs: Math.round(performance.now() - started),
      });

    // Storage first: when it fails the key stays in the row for the next run.
    if ((await this.cleaner.remove(row.key)) === 'unavailable') {
      audit('unavailable', 'warn');
      return false;
    }
    await this.dataSource.query(
      `UPDATE transformations
          SET storage_status = 'not_requested', stored_file_key = NULL,
              stored_file_until = NULL, storage_error_code = NULL
        WHERE id = $1 AND storage_status = 'available' AND stored_file_key = $2`,
      [row.id, row.key],
    );
    audit('success', 'log');
    return true;
  }
}
