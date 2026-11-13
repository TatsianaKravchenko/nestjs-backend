/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import {
  StorageCleanupJob,
  StorageCleanupReason,
  StorageCleanupStatus,
} from '../entities/storage-cleanup-job.entity';
import { StorageCleanupWorker } from './storage-cleanup.worker';

const SECRET_KEY = 'secret-object-key-123.webp';
const NOW = new Date('2026-06-01T12:00:00Z');

describe('StorageCleanupWorker', () => {
  let env: Record<string, string>;
  let job: StorageCleanupJob | null;
  const query = {
    setLock: jest.fn(),
    setOnLocked: jest.fn(),
    where: jest.fn(),
    getOne: jest.fn(),
  };
  const manager = {
    createQueryBuilder: jest.fn(),
    query: jest.fn(),
    save: jest.fn(),
  };
  const repository = { find: jest.fn() };
  const dataSource = {
    getRepository: jest.fn(),
    transaction: jest.fn(),
    query: jest.fn(),
  };
  const audit = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const storage = {
    read: jest.fn(),
    write: jest.fn(),
    delete: jest.fn(),
    listOlderThan: jest.fn(),
  };
  const config = { get: (key: string) => env[key] };
  const worker = new StorageCleanupWorker(
    dataSource as never,
    config as never,
    audit as never,
    storage as never,
  );

  const makeJob = (fields: Partial<StorageCleanupJob> = {}) =>
    Object.assign(new StorageCleanupJob(), {
      id: 'job-1',
      objectKey: SECRET_KEY,
      reason: StorageCleanupReason.PHOTO_CLEARED,
      status: StorageCleanupStatus.QUEUED,
      attempts: 0,
      nextAttemptAt: new Date(NOW.getTime() - 1000),
      lastErrorCode: null,
      ...fields,
    });
  const auditDump = () =>
    JSON.stringify([
      ...audit.info.mock.calls,
      ...audit.warn.mock.calls,
      ...audit.error.mock.calls,
    ]);

  beforeEach(() => {
    jest.resetAllMocks();
    env = {
      STORAGE_CLEANUP_WORKER_ENABLED: 'true',
      STORAGE_CLEANUP_INTERVAL_MS: '1000',
      STORAGE_ORPHAN_SWEEP_INTERVAL_MS: '5000',
    };
    job = makeJob();
    dataSource.getRepository.mockReturnValue(repository);
    repository.find.mockResolvedValue([{ id: 'job-1' }]);
    dataSource.transaction.mockImplementation((work: (m: unknown) => unknown) =>
      work(manager),
    );
    manager.createQueryBuilder.mockReturnValue(query);
    query.setLock.mockReturnValue(query);
    query.setOnLocked.mockReturnValue(query);
    query.where.mockReturnValue(query);
    query.getOne.mockImplementation(() => Promise.resolve(job));
    manager.query.mockResolvedValue([]);
    manager.save.mockImplementation((value: unknown) => Promise.resolve(value));
    storage.delete.mockResolvedValue('deleted');
  });

  describe('processDue', () => {
    it('claims jobs with SKIP LOCKED and deletes the object', async () => {
      const handled = await worker.processDue(NOW);

      expect(handled).toBe(1);
      expect(query.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(query.setOnLocked).toHaveBeenCalledWith('skip_locked');
      expect(storage.delete).toHaveBeenCalledWith(SECRET_KEY);
      expect(job).toMatchObject({
        status: StorageCleanupStatus.SUCCEEDED,
        attempts: 1,
        lastErrorCode: null,
      });
      expect(manager.save).toHaveBeenCalledWith(job);
    });

    it('treats not_found as success', async () => {
      storage.delete.mockResolvedValue('not_found');

      await worker.processDue(NOW);

      expect(job!.status).toBe(StorageCleanupStatus.SUCCEEDED);
      expect(audit.info).toHaveBeenCalledWith(
        'storage.cleanup.succeeded',
        expect.objectContaining({ result: 'not_found' }),
      );
    });

    it('queries only queued jobs that are due, oldest first', async () => {
      await worker.processDue(NOW);

      const options = repository.find.mock.calls[0][0] as {
        where: { status: string };
        order: Record<string, string>;
        take: number;
      };
      expect(options.where.status).toBe(StorageCleanupStatus.QUEUED);
      expect(options.order).toEqual({ nextAttemptAt: 'ASC' });
      expect(options.take).toBe(20);
    });

    it('retries after one minute when storage is unavailable', async () => {
      storage.delete.mockResolvedValue('unavailable');

      await worker.processDue(NOW);

      expect(job).toMatchObject({
        status: StorageCleanupStatus.QUEUED,
        attempts: 1,
        lastErrorCode: 'storage_unavailable',
      });
      expect(job!.nextAttemptAt).toEqual(new Date(NOW.getTime() + 60_000));
      expect(audit.warn).toHaveBeenCalledWith(
        'storage.cleanup.retry',
        expect.objectContaining({ attempts: 1 }),
      );
    });

    it('fails the job on the fifth attempt', async () => {
      job = makeJob({ attempts: 4 });
      storage.delete.mockResolvedValue('unavailable');

      await worker.processDue(NOW);

      expect(job).toMatchObject({
        status: StorageCleanupStatus.FAILED,
        attempts: 5,
        lastErrorCode: 'storage_unavailable',
      });
      expect(audit.error).toHaveBeenCalledWith(
        'storage.cleanup.failed',
        expect.objectContaining({ attempts: 5 }),
      );
    });

    it('does not delete a key a profile still references and fails the job', async () => {
      manager.query.mockResolvedValue([{ '?column?': 1 }]);

      await worker.processDue(NOW);

      expect(storage.delete).not.toHaveBeenCalled();
      expect(job).toMatchObject({
        status: StorageCleanupStatus.FAILED,
        lastErrorCode: 'still_referenced',
      });
    });

    it('skips a job that another instance holds or already finished', async () => {
      job = null;

      const handled = await worker.processDue(NOW);

      expect(handled).toBe(0);
      expect(storage.delete).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('returns 0 when nothing is due', async () => {
      repository.find.mockResolvedValue([]);

      expect(await worker.processDue(NOW)).toBe(0);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('never puts the object key into the log', async () => {
      await worker.processDue(NOW);
      storage.delete.mockResolvedValue('unavailable');
      job = makeJob({ attempts: 4 });
      await worker.processDue(NOW);
      job = makeJob();
      storage.delete.mockResolvedValue('unavailable');
      await worker.processDue(NOW);

      const logged = auditDump();
      expect(logged).not.toContain(SECRET_KEY);
      expect(logged).toContain('job-1');
    });
  });

  describe('sweepOrphans', () => {
    it('lists objects older than one hour and deletes only unreferenced, unqueued ones', async () => {
      storage.listOlderThan.mockResolvedValue([
        { key: 'referenced.webp', lastModified: new Date(0) },
        { key: 'queued.webp', lastModified: new Date(0) },
        { key: 'orphan-1.webp', lastModified: new Date(0) },
        { key: 'orphan-2.webp', lastModified: new Date(0) },
      ]);
      dataSource.query.mockResolvedValue([
        { key: 'referenced.webp' },
        { key: 'queued.webp' },
      ]);

      const deleted = await worker.sweepOrphans(NOW);

      expect(storage.listOlderThan).toHaveBeenCalledWith(
        new Date(NOW.getTime() - 3_600_000),
      );
      expect(deleted).toBe(2);
      expect(
        (storage.delete.mock.calls as string[][]).map(([key]) => key).sort(),
      ).toEqual(['orphan-1.webp', 'orphan-2.webp']);
      expect(audit.info).toHaveBeenCalledWith('storage.orphans.deleted', {
        count: 2,
      });
      expect(auditDump()).not.toContain('orphan-1');
    });

    it('does not count an object that vanished or could not be deleted', async () => {
      storage.listOlderThan.mockResolvedValue([
        { key: 'a.webp', lastModified: new Date(0) },
        { key: 'b.webp', lastModified: new Date(0) },
      ]);
      dataSource.query.mockResolvedValue([]);
      storage.delete
        .mockResolvedValueOnce('not_found')
        .mockResolvedValueOnce('unavailable');

      expect(await worker.sweepOrphans(NOW)).toBe(0);
      expect(audit.info).not.toHaveBeenCalled();
    });

    it('does nothing for an empty listing', async () => {
      storage.listOlderThan.mockResolvedValue([]);

      expect(await worker.sweepOrphans(NOW)).toBe(0);
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('checks references in batches of 200', async () => {
      storage.listOlderThan.mockResolvedValue(
        Array.from({ length: 450 }, (_v, i) => ({
          key: `k${i}.webp`,
          lastModified: new Date(0),
        })),
      );
      dataSource.query.mockResolvedValue([]);

      expect(await worker.sweepOrphans(NOW)).toBe(450);
      expect(dataSource.query).toHaveBeenCalledTimes(3);
    });
  });

  describe('timers', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
      worker.onModuleDestroy();
      jest.useRealTimers();
    });

    it('runs both tasks on their intervals and stops on destroy', async () => {
      const due = jest.spyOn(worker, 'processDue').mockResolvedValue(0);
      const sweep = jest.spyOn(worker, 'sweepOrphans').mockResolvedValue(0);

      worker.onModuleInit();
      await jest.advanceTimersByTimeAsync(5000);

      expect(due).toHaveBeenCalledTimes(5);
      expect(sweep).toHaveBeenCalledTimes(1);

      worker.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(20_000);

      expect(due).toHaveBeenCalledTimes(5);
      expect(sweep).toHaveBeenCalledTimes(1);
    });

    it('starts nothing when STORAGE_CLEANUP_WORKER_ENABLED is false', async () => {
      env.STORAGE_CLEANUP_WORKER_ENABLED = 'false';
      const due = jest.spyOn(worker, 'processDue').mockResolvedValue(0);

      worker.onModuleInit();
      await jest.advanceTimersByTimeAsync(10_000);

      expect(due).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('swallows a task error and logs it without details', async () => {
      jest
        .spyOn(worker, 'processDue')
        .mockRejectedValue(new Error(`failed on ${SECRET_KEY}`));
      jest.spyOn(worker, 'sweepOrphans').mockResolvedValue(0);

      worker.onModuleInit();
      await jest.advanceTimersByTimeAsync(1000);

      expect(audit.error).toHaveBeenCalledWith('storage.cleanup.worker_error', {
        task: 'jobs',
      });
      expect(auditDump()).not.toContain(SECRET_KEY);
    });

    it('does not start a task again while the previous run is still going', async () => {
      let release: () => void = () => undefined;
      const due = jest.spyOn(worker, 'processDue').mockImplementation(
        () =>
          new Promise<number>((resolve) => {
            release = () => resolve(0);
          }),
      );
      jest.spyOn(worker, 'sweepOrphans').mockResolvedValue(0);

      worker.onModuleInit();
      await jest.advanceTimersByTimeAsync(3000);
      expect(due).toHaveBeenCalledTimes(1);

      release();
      await jest.advanceTimersByTimeAsync(1000);
      expect(due).toHaveBeenCalledTimes(2);
    });
  });
});
