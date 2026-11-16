import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';

import { User, UserStatus } from '../../entities/user.entity';
import { LOCK } from '../../profile/utils/profile-support';
import { PHOTO_STORAGE, type PhotoStorage } from '../../storage/photo-storage';
import {
  DELETION_MAX_ATTEMPTS,
  DELETION_RETRY_DELAY_MS,
  DeletionJob,
  DeletionJobStatus,
} from '../entities/deletion-job.entity';
import type { EraseResult } from './user-eraser';
import { UserEraserRegistry } from './user-eraser.registry';
import { deleteChallenges } from './user-erasers';

const BATCH = 10;

interface Claimed {
  id: string;
  userId: string;
  attempts: number;
}

type Finalized =
  | { kind: 'ok' }
  | { kind: 'lost' }
  | { kind: 'retry'; code: string };

/**
 * Runs the deletion jobs. A job is claimed atomically (`FOR UPDATE SKIP LOCKED`)
 * with a lease, so several instances never run it twice at once and a crashed
 * run is picked up when the lease ends. Every registered eraser runs (they are
 * idempotent); only when all succeeded is the user finalized in one
 * transaction: tombstone email, no name, photo or password, status `deleted`.
 * A retryable failure is repeated after a minute, `failed` after 5 runs; the
 * user stays `deleting`. The log carries event names and results only.
 */
@Injectable()
export class DeletionWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly audit: AuthAuditService,
    private readonly registry: UserEraserRegistry,
    @Inject(PHOTO_STORAGE) private readonly storage: PhotoStorage,
  ) {}

  onModuleInit(): void {
    if (String(this.config.get('DELETION_WORKER_ENABLED')) === 'false') return;
    this.timer = setInterval(
      () => void this.guarded(),
      Number(this.config.get('DELETION_WORKER_INTERVAL_MS')),
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Claims and runs due jobs; returns how many were handled. */
  async processDue(now = new Date()): Promise<number> {
    let handled = 0;
    for (let i = 0; i < BATCH; i++) {
      const job = await this.claim(now);
      if (!job) break;
      await this.run(job, now);
      handled += 1;
    }
    return handled;
  }

  /** Marks one due job `running` with a lease; null when nothing is due. */
  private claim(now: Date): Promise<Claimed | null> {
    const lease = new Date(
      now.getTime() +
        Number(this.config.get('DELETION_WORKER_LEASE_SECONDS')) * 1000,
    );
    return this.dataSource.transaction(async (manager) => {
      const job = await manager
        .createQueryBuilder(DeletionJob, 'job')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where(
          '(job.status = :queued AND job.nextAttemptAt <= :now) OR (job.status = :running AND job.leaseUntil < :now)',
          {
            queued: DeletionJobStatus.QUEUED,
            running: DeletionJobStatus.RUNNING,
            now,
          },
        )
        .orderBy('job.nextAttemptAt', 'ASC')
        .limit(1)
        .getOne();
      if (!job) return null;
      job.status = DeletionJobStatus.RUNNING;
      job.attempts += 1;
      job.leaseUntil = lease;
      await manager.save(job);
      return { id: job.id, userId: job.userId, attempts: job.attempts };
    });
  }

  private async run(job: Claimed, now: Date): Promise<void> {
    let failure: { permanent: boolean; code: string } | undefined;
    for (const eraser of this.registry.all()) {
      const result = await this.safeErase(eraser.erase(job.userId));
      if (result.status === 'permanent_failure') {
        failure = { permanent: true, code: result.code };
        break;
      }
      if (result.status === 'retryable_failure') {
        failure ??= { permanent: false, code: result.code };
      }
    }

    if (!failure) {
      const done = await this.finalize(job).catch(
        (): Finalized => ({ kind: 'retry', code: 'finalize_error' }),
      );
      if (done.kind === 'ok') {
        this.audit.info('users.deletion.job', { result: 'succeeded' });
        return;
      }
      if (done.kind === 'lost') return;
      failure = { permanent: false, code: done.code };
    }
    await this.fail(job, failure, now);
  }

  private async safeErase(work: Promise<EraseResult>): Promise<EraseResult> {
    try {
      return await work;
    } catch {
      return { status: 'retryable_failure', code: 'eraser_error' };
    }
  }

  /** Requeue after a minute, or `failed` for a permanent failure or the 5th run. */
  private async fail(
    job: Claimed,
    failure: { permanent: boolean; code: string },
    now: Date,
  ): Promise<void> {
    const final = failure.permanent || job.attempts >= DELETION_MAX_ATTEMPTS;
    await this.dataSource
      .createQueryBuilder()
      .update(DeletionJob)
      .set({
        status: final ? DeletionJobStatus.FAILED : DeletionJobStatus.QUEUED,
        leaseUntil: null,
        nextAttemptAt: new Date(now.getTime() + DELETION_RETRY_DELAY_MS),
        lastErrorCode: failure.code.slice(0, 64),
      })
      .where('id = :id AND status = :running AND attempts = :attempts', {
        id: job.id,
        running: DeletionJobStatus.RUNNING,
        attempts: job.attempts,
      })
      .execute();
    this.audit[final ? 'error' : 'warn']('users.deletion.job', {
      result: final ? 'failed' : 'retry',
      errorCode: failure.code,
    });
  }

  /** One transaction: nothing personal is left, the user is `deleted`. */
  private finalize(job: Claimed): Promise<Finalized> {
    return this.dataSource.transaction(async (manager): Promise<Finalized> => {
      const user = await manager.findOne(User, {
        where: { id: job.userId },
        lock: LOCK,
      });
      const current = await manager.findOne(DeletionJob, {
        where: { id: job.id },
        lock: LOCK,
      });
      if (
        !user ||
        !current ||
        current.status !== DeletionJobStatus.RUNNING ||
        current.attempts !== job.attempts ||
        user.status !== UserStatus.DELETING
      ) {
        return { kind: 'lost' };
      }

      // The photo must really be gone before the reference is dropped.
      if (user.photoKey) {
        const read = await this.storage.read(user.photoKey);
        if (read.status === 'found') {
          read.stream.destroy();
          return { kind: 'retry', code: 'photo_present' };
        }
        if (read.status === 'unavailable') {
          return { kind: 'retry', code: 'storage_unavailable' };
        }
      }

      await deleteChallenges(manager, user.id);
      await manager.update(
        User,
        { id: user.id },
        {
          email: current.tombstoneEmail,
          displayName: null,
          photoKey: null,
          passwordHash: null,
          status: UserStatus.DELETED,
        },
      );
      current.status = DeletionJobStatus.SUCCEEDED;
      current.leaseUntil = null;
      current.lastErrorCode = null;
      await manager.save(current);
      return { kind: 'ok' };
    });
  }

  private async guarded(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.processDue();
    } catch {
      this.audit.error('users.deletion.worker_error');
    } finally {
      this.running = false;
    }
  }
}
