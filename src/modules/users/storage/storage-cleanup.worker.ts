import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DataSource, LessThanOrEqual } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';

import {
  CLEANUP_MAX_ATTEMPTS,
  CLEANUP_RETRY_DELAY_MS,
  StorageCleanupJob,
  StorageCleanupStatus,
} from '../entities/storage-cleanup-job.entity';
import { PHOTO_STORAGE, type PhotoStorage } from './photo-storage';

const BATCH = 20;
const ORPHAN_AGE_MS = 60 * 60 * 1000;

/**
 * Deletes objects of replaced or cleared photos (`storage_cleanup_jobs`) and
 * sweeps unreferenced objects older than one hour. Safe on several instances:
 * each job is claimed with `FOR UPDATE SKIP LOCKED`. A missing object counts
 * as deleted. A failing job is retried every minute and is `failed` after 5
 * attempts. Logs carry job ids and codes, never object keys.
 */
@Injectable()
export class StorageCleanupWorker implements OnModuleInit, OnModuleDestroy {
  private timers: NodeJS.Timeout[] = [];
  private running = { jobs: false, orphans: false };

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly audit: AuthAuditService,
    @Inject(PHOTO_STORAGE) private readonly storage: PhotoStorage,
  ) {}

  onModuleInit(): void {
    if (String(this.config.get('STORAGE_CLEANUP_WORKER_ENABLED')) === 'false') {
      return;
    }
    this.timers = [
      setInterval(
        () => void this.guarded('jobs', () => this.processDue()),
        Number(this.config.get('STORAGE_CLEANUP_INTERVAL_MS')),
      ),
      setInterval(
        () => void this.guarded('orphans', () => this.sweepOrphans()),
        Number(this.config.get('STORAGE_ORPHAN_SWEEP_INTERVAL_MS')),
      ),
    ];
    for (const timer of this.timers) timer.unref();
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  /** Processes due `queued` jobs; returns how many were handled. */
  async processDue(now = new Date()): Promise<number> {
    const due = await this.dataSource.getRepository(StorageCleanupJob).find({
      where: {
        status: StorageCleanupStatus.QUEUED,
        nextAttemptAt: LessThanOrEqual(now),
      },
      select: { id: true },
      order: { nextAttemptAt: 'ASC' },
      take: BATCH,
    });
    let handled = 0;
    for (const { id } of due) {
      if (await this.runJob(id, now)) handled += 1;
    }
    return handled;
  }

  private runJob(id: string, now: Date): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const job = await manager
        .createQueryBuilder(StorageCleanupJob, 'job')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where('job.id = :id AND job.status = :status', {
          id,
          status: StorageCleanupStatus.QUEUED,
        })
        .getOne();
      if (!job) return false; // taken by another instance or already done

      // Never delete an object a profile still points at.
      const referenced: unknown[] = await manager.query(
        'SELECT 1 FROM users WHERE photo_key = $1 LIMIT 1',
        [job.objectKey],
      );
      const result = referenced.length
        ? ('still_referenced' as const)
        : await this.storage.delete(job.objectKey);

      job.attempts += 1;
      if (result === 'deleted' || result === 'not_found') {
        job.status = StorageCleanupStatus.SUCCEEDED;
        job.lastErrorCode = null;
        this.audit.info('storage.cleanup.succeeded', {
          jobId: job.id,
          reason: job.reason,
          attempts: job.attempts,
          result,
        });
      } else if (
        result === 'still_referenced' ||
        job.attempts >= CLEANUP_MAX_ATTEMPTS
      ) {
        job.status = StorageCleanupStatus.FAILED;
        job.lastErrorCode =
          result === 'still_referenced' ? result : 'storage_unavailable';
        this.audit.error('storage.cleanup.failed', {
          jobId: job.id,
          reason: job.reason,
          attempts: job.attempts,
          errorCode: job.lastErrorCode,
        });
      } else {
        job.lastErrorCode = 'storage_unavailable';
        job.nextAttemptAt = new Date(now.getTime() + CLEANUP_RETRY_DELAY_MS);
        this.audit.warn('storage.cleanup.retry', {
          jobId: job.id,
          reason: job.reason,
          attempts: job.attempts,
          errorCode: job.lastErrorCode,
        });
      }
      await manager.save(job);
      return true;
    });
  }

  /**
   * Deletes objects older than one hour that no profile references and no
   * queued job will delete. Returns the number of deleted objects.
   */
  async sweepOrphans(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - ORPHAN_AGE_MS);
    const candidates = await this.storage.listOlderThan(cutoff);
    if (candidates.length === 0) return 0;

    let deleted = 0;
    for (let i = 0; i < candidates.length; i += 200) {
      const keys = candidates.slice(i, i + 200).map((object) => object.key);
      const rows: { key: string }[] = await this.dataSource.query(
        `SELECT photo_key AS key FROM users WHERE photo_key = ANY($1)
         UNION
         SELECT object_key AS key FROM storage_cleanup_jobs
          WHERE status = 'queued' AND object_key = ANY($1)`,
        [keys],
      );
      const keep = new Set(rows.map((row) => row.key));
      for (const key of keys) {
        if (keep.has(key)) continue;
        const result = await this.storage.delete(key);
        if (result === 'deleted') deleted += 1;
      }
    }
    if (deleted > 0) {
      this.audit.info('storage.orphans.deleted', { count: deleted });
    }
    return deleted;
  }

  private async guarded(
    name: 'jobs' | 'orphans',
    work: () => Promise<unknown>,
  ): Promise<void> {
    if (this.running[name]) return;
    this.running[name] = true;
    try {
      await work();
    } catch {
      this.audit.error('storage.cleanup.worker_error', { task: name });
    } finally {
      this.running[name] = false;
    }
  }
}
