import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';

import { RESULT_STORE, type ResultStore } from './result-store';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Upper bound of batches per run, so one run cannot hold the worker forever. */
const MAX_BATCHES_PER_RUN = 100;

interface ExpiredRow {
  id: string;
  storageKey: string | null;
}

export interface RetentionRunResult {
  deleted: number;
  /** Rows kept for the next run because their stored file could not be deleted. */
  skipped: number;
}

/**
 * Removes history rows older than `TRANSFORM_HISTORY_RETENTION_DAYS` (90 by
 * default) in batches. A row with a stored file loses the file first, through
 * the storage adapter; a missing object counts as already cleaned. When the
 * storage is unavailable the row stays, so the key is not lost and the next run
 * retries. Safe on several instances: deleting a deleted row is a no-op. Logs
 * carry counts only, never keys.
 */
@Injectable()
export class HistoryRetentionWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly audit: AuthAuditService,
    @Inject(RESULT_STORE) private readonly results: ResultStore,
  ) {}

  onModuleInit(): void {
    if (
      String(this.config.get('TRANSFORM_HISTORY_CLEANUP_ENABLED')) === 'false'
    ) {
      return;
    }
    this.timer = setInterval(
      () => void this.guarded(),
      Number(this.config.get('TRANSFORM_HISTORY_CLEANUP_INTERVAL_MS')),
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async guarded(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.run();
    } catch {
      this.audit.error('transformations.history.cleanup_failed', {
        result: 'error',
      });
    } finally {
      this.running = false;
    }
  }

  /** Deletes every expired row, batch by batch. */
  async run(now = new Date()): Promise<RetentionRunResult> {
    const days = Number(this.config.get('TRANSFORM_HISTORY_RETENTION_DAYS'));
    const batchSize = Number(
      this.config.get('TRANSFORM_HISTORY_CLEANUP_BATCH_SIZE'),
    );
    const cutoff = new Date(now.getTime() - days * DAY_MS);
    const total: RetentionRunResult = { deleted: 0, skipped: 0 };

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      const rows = await this.expired(cutoff, batchSize);
      if (rows.length === 0) break;
      const result = await this.clean(rows);
      total.deleted += result.deleted;
      total.skipped += result.skipped;
      // Nothing removed: the same rows would come back; leave them for the next run.
      if (result.deleted === 0 || rows.length < batchSize) break;
    }

    if (total.deleted > 0 || total.skipped > 0) {
      this.audit.info('transformations.history.cleanup', {
        result: total.skipped > 0 ? 'partial' : 'success',
        deleted: total.deleted,
        skipped: total.skipped,
        retentionDays: days,
      });
    }
    return total;
  }

  private expired(cutoff: Date, limit: number): Promise<ExpiredRow[]> {
    return this.dataSource.query(
      `SELECT t.id AS id, o.storage_key AS "storageKey"
         FROM transformations t
         LEFT JOIN transformation_objects o ON o.transformation_id = t.id
        WHERE t.created_at < $1
        ORDER BY t.created_at ASC, t.id ASC
        LIMIT $2`,
      [cutoff, limit],
    );
  }

  private async clean(rows: ExpiredRow[]): Promise<RetentionRunResult> {
    const removable: string[] = [];
    let skipped = 0;
    for (const row of rows) {
      if (row.storageKey !== null) {
        const outcome = await this.results.delete(row.storageKey);
        if (outcome === 'unavailable') {
          skipped += 1;
          continue;
        }
      }
      removable.push(row.id);
    }
    if (removable.length > 0) {
      // The object rows follow their transformation (ON DELETE CASCADE).
      await this.dataSource.query(
        'DELETE FROM transformations WHERE id = ANY($1::uuid[])',
        [removable],
      );
    }
    return { deleted: removable.length, skipped };
  }
}
