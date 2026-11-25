import { Logger } from '@nestjs/common';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  StoragePermanentError,
  StorageUnavailableError,
} from './object-storage';
import { StoredFileWorker } from './stored-file.worker';

const NOW = new Date('2026-04-01T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const USER = '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44';
const KEY = 'SECRET-opaque-key-0123456789';

const settings: Record<string, unknown> = {};

const defaults = (): Record<string, unknown> => ({
  TRANSFORM_UPLOAD_WORKER_ENABLED: true,
  TRANSFORM_UPLOAD_INTERVAL_MS: 1000,
  TRANSFORM_UPLOAD_BATCH_SIZE: 2,
  TRANSFORM_UPLOAD_MAX_AGE_MS: 60 * 60 * 1000,
  TRANSFORM_STORED_FILE_RETENTION_DAYS: 7,
  TRANSFORM_STORED_FILE_CLEANUP_ENABLED: true,
  TRANSFORM_STORED_FILE_CLEANUP_INTERVAL_MS: 5000,
  TRANSFORM_STORED_FILE_CLEANUP_BATCH_SIZE: 2,
});

describe('StoredFileWorker', () => {
  const query = jest.fn();
  const staging = { pathOf: jest.fn(), remove: jest.fn() };
  const cleaner = { remove: jest.fn() };
  const audit = { storage: jest.fn() };
  const storage = { save: jest.fn() };
  const config = { get: (name: string) => settings[name] };
  let worker: StoredFileWorker;
  let dir: string;
  let stagedPath: string;
  let errorLog: jest.SpyInstance;

  const pending = (overrides: Record<string, unknown> = {}) => ({
    id: 'row-1',
    userId: USER,
    key: KEY,
    outputSize: '20',
    completedAt: new Date(NOW.getTime() - 1000),
    ...overrides,
  });

  const updates = (): [string, unknown[]][] =>
    (query.mock.calls as [string, unknown[]][]).filter(([sql]) =>
      sql.trimStart().startsWith('UPDATE'),
    );

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stored-file-worker-'));
    stagedPath = join(dir, 'staged.bin');
    await writeFile(stagedPath, 'hello');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.resetAllMocks();
    for (const name of Object.keys(settings)) delete settings[name];
    Object.assign(settings, defaults());
    staging.pathOf.mockReturnValue(stagedPath);
    staging.remove.mockResolvedValue(true);
    storage.save.mockResolvedValue(undefined);
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    worker = new StoredFileWorker(
      { query } as never,
      config as never,
      staging as never,
      cleaner as never,
      audit as never,
      storage as never,
    );
  });

  afterEach(() => {
    worker.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('uploadPending', () => {
    it('selects pending rows oldest first, limited to the batch size', async () => {
      query.mockResolvedValueOnce([]);
      await expect(worker.uploadPending(NOW)).resolves.toEqual({
        uploaded: 0,
        failed: 0,
        retried: 0,
      });
      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("storage_status = 'pending'");
      expect(sql).toContain('ORDER BY completed_at ASC');
      expect(params).toEqual([2]);
    });

    it('uploads, marks available until now + retention days and removes the staged copy', async () => {
      query.mockResolvedValueOnce([pending()]).mockResolvedValueOnce([{}]);

      await expect(worker.uploadPending(NOW)).resolves.toEqual({
        uploaded: 1,
        failed: 0,
        retried: 0,
      });

      expect(storage.save).toHaveBeenCalledWith(KEY, stagedPath);
      const [sql, params] = updates()[0];
      expect(sql).toContain("storage_status = 'available'");
      expect(sql).toContain("storage_status = 'pending'");
      expect(params).toEqual(['row-1', new Date(NOW.getTime() + 7 * DAY_MS)]);
      expect(staging.remove).toHaveBeenCalledWith(KEY);
      expect(audit.storage).toHaveBeenCalledWith(
        'log',
        'transformation.stored_file.save',
        expect.objectContaining({
          userId: USER,
          transformationId: 'row-1',
          action: 'save',
          size: 20,
          outcome: 'success',
        }),
      );
      expect(JSON.stringify(audit.storage.mock.calls)).not.toContain('SECRET');
    });

    it('omits the size when it is unknown', async () => {
      query
        .mockResolvedValueOnce([pending({ outputSize: null })])
        .mockResolvedValueOnce([{}]);
      await worker.uploadPending(NOW);
      expect((audit.storage.mock.calls[0] as unknown[])[2]).not.toHaveProperty(
        'size',
      );
    });

    it('is idempotent: a retry uploads again under the same key', async () => {
      query
        .mockResolvedValueOnce([pending()])
        .mockResolvedValueOnce([{}])
        .mockResolvedValueOnce([pending()])
        .mockResolvedValueOnce([{}]);
      await worker.uploadPending(NOW);
      await worker.uploadPending(NOW);
      expect(storage.save.mock.calls.map((c) => (c as string[])[0])).toEqual([
        KEY,
        KEY,
      ]);
    });

    it('a row that is no longer pending after the upload is counted as uploaded without touching staging or the audit', async () => {
      query.mockResolvedValueOnce([pending()]).mockResolvedValueOnce([]);
      await expect(worker.uploadPending(NOW)).resolves.toMatchObject({
        uploaded: 1,
      });
      expect(staging.remove).not.toHaveBeenCalled();
      expect(audit.storage).not.toHaveBeenCalled();
    });

    it('a missing staged copy is an error with staging_missing', async () => {
      staging.pathOf.mockReturnValue(join(dir, 'does-not-exist'));
      query.mockResolvedValueOnce([pending()]).mockResolvedValueOnce([{}]);

      await expect(worker.uploadPending(NOW)).resolves.toEqual({
        uploaded: 0,
        failed: 1,
        retried: 0,
      });

      expect(storage.save).not.toHaveBeenCalled();
      expect(updates()[0][1]).toEqual(['row-1', 'staging_missing']);
      expect(staging.remove).toHaveBeenCalledWith(KEY);
      expect(audit.storage).toHaveBeenCalledWith(
        'error',
        'transformation.stored_file.save',
        expect.objectContaining({
          outcome: 'error',
          errorCode: 'staging_missing',
        }),
      );
    });

    it('a staged path that is a directory counts as missing', async () => {
      staging.pathOf.mockReturnValue(dir);
      query.mockResolvedValueOnce([pending()]).mockResolvedValueOnce([{}]);
      await worker.uploadPending(NOW);
      expect(updates()[0][1]).toEqual(['row-1', 'staging_missing']);
    });

    it('an invalid key (no staged path) is staging_missing', async () => {
      staging.pathOf.mockReturnValue(null);
      query.mockResolvedValueOnce([pending()]).mockResolvedValueOnce([{}]);
      await worker.uploadPending(NOW);
      expect(updates()[0][1]).toEqual(['row-1', 'staging_missing']);
    });

    it('a copy pending for too long is an error with upload_timeout, even if staged', async () => {
      query
        .mockResolvedValueOnce([
          pending({ completedAt: new Date(NOW.getTime() - 2 * 3600 * 1000) }),
        ])
        .mockResolvedValueOnce([{}]);

      await expect(worker.uploadPending(NOW)).resolves.toMatchObject({
        failed: 1,
      });

      expect(storage.save).not.toHaveBeenCalled();
      expect(updates()[0][1]).toEqual(['row-1', 'upload_timeout']);
      expect(staging.remove).toHaveBeenCalledWith(KEY);
    });

    it('when the row is no longer pending, the error path leaves staging alone and retries', async () => {
      staging.pathOf.mockReturnValue(null);
      query.mockResolvedValueOnce([pending()]).mockResolvedValueOnce([]);
      await expect(worker.uploadPending(NOW)).resolves.toMatchObject({
        failed: 0,
        retried: 1,
      });
      expect(staging.remove).not.toHaveBeenCalled();
      expect(audit.storage).not.toHaveBeenCalled();
    });

    it('a permanent storage failure is an error with its code', async () => {
      storage.save.mockRejectedValue(new StoragePermanentError('key'));
      query.mockResolvedValueOnce([pending()]).mockResolvedValueOnce([{}]);

      await expect(worker.uploadPending(NOW)).resolves.toMatchObject({
        failed: 1,
      });

      expect(updates()[0][1]).toEqual(['row-1', 'key']);
      expect(staging.remove).toHaveBeenCalledWith(KEY);
      expect(audit.storage).toHaveBeenCalledWith(
        'error',
        'transformation.stored_file.save',
        expect.objectContaining({ errorCode: 'key' }),
      );
    });

    it('a permanent failure on a row that is no longer pending is retried, not failed', async () => {
      storage.save.mockRejectedValue(new StoragePermanentError());
      query.mockResolvedValueOnce([pending()]).mockResolvedValueOnce([]);
      await expect(worker.uploadPending(NOW)).resolves.toMatchObject({
        failed: 0,
        retried: 1,
      });
      expect(staging.remove).not.toHaveBeenCalled();
    });

    it('a transient failure keeps the row pending and the staged copy', async () => {
      storage.save.mockRejectedValue(new StorageUnavailableError());
      query.mockResolvedValueOnce([pending()]);

      await expect(worker.uploadPending(NOW)).resolves.toEqual({
        uploaded: 0,
        failed: 0,
        retried: 1,
      });

      expect(updates()).toHaveLength(0);
      expect(staging.remove).not.toHaveBeenCalled();
      expect(audit.storage).toHaveBeenCalledWith(
        'warn',
        'transformation.stored_file.save',
        expect.objectContaining({
          outcome: 'unavailable',
          errorCode: 'storage_unavailable',
        }),
      );
    });

    it('treats any other storage error as transient', async () => {
      storage.save.mockRejectedValue(new Error('weird'));
      query.mockResolvedValueOnce([pending()]);
      await expect(worker.uploadPending(NOW)).resolves.toMatchObject({
        retried: 1,
      });
    });

    it('processes every row of the batch independently', async () => {
      storage.save
        .mockRejectedValueOnce(new StorageUnavailableError())
        .mockResolvedValueOnce(undefined);
      query
        .mockResolvedValueOnce([pending({ id: 'a' }), pending({ id: 'b' })])
        .mockResolvedValueOnce([{}]);
      await expect(worker.uploadPending(NOW)).resolves.toEqual({
        uploaded: 1,
        failed: 0,
        retried: 1,
      });
    });

    it('defaults the clock to now', async () => {
      query.mockResolvedValueOnce([]);
      await expect(worker.uploadPending()).resolves.toMatchObject({
        uploaded: 0,
      });
    });
  });

  describe('cleanupExpired', () => {
    const expired = (id: string, key = `${KEY}-${id}`) => ({
      id,
      userId: USER,
      key,
      outputSize: '5',
    });

    it('selects available rows past their expiry, oldest first', async () => {
      query.mockResolvedValueOnce([]);
      await expect(worker.cleanupExpired(NOW)).resolves.toEqual({
        deleted: 0,
        skipped: 0,
      });
      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("storage_status = 'available'");
      expect(sql).toContain('stored_file_until < $1');
      expect(sql).toContain('ORDER BY stored_file_until ASC');
      expect(params).toEqual([NOW, 2]);
    });

    it('deletes the stored file first, then clears the row fields', async () => {
      const order: string[] = [];
      cleaner.remove.mockImplementation((key: string) => {
        order.push(`remove:${key}`);
        return Promise.resolve('deleted');
      });
      query.mockResolvedValueOnce([expired('a')]).mockImplementationOnce(() => {
        order.push('update');
        return Promise.resolve([]);
      });

      await expect(worker.cleanupExpired(NOW)).resolves.toEqual({
        deleted: 1,
        skipped: 0,
      });

      expect(order).toEqual([`remove:${KEY}-a`, 'update']);
      const [sql, params] = updates()[0];
      expect(sql).toContain("storage_status = 'not_requested'");
      expect(sql).toContain('stored_file_key = NULL');
      expect(sql).toContain('stored_file_until = NULL');
      expect(sql).toContain('storage_error_code = NULL');
      expect(sql).toContain("storage_status = 'available'");
      expect(params).toEqual(['a', `${KEY}-a`]);
      expect(audit.storage).toHaveBeenCalledWith(
        'log',
        'transformation.stored_file.delete',
        expect.objectContaining({
          action: 'delete',
          outcome: 'success',
          size: 5,
        }),
      );
      expect(JSON.stringify(audit.storage.mock.calls)).not.toContain('SECRET');
    });

    it('treats a missing stored file as already deleted', async () => {
      cleaner.remove.mockResolvedValue('not_found');
      query
        .mockResolvedValueOnce([{ ...expired('a'), outputSize: null }])
        .mockResolvedValueOnce([]);
      await expect(worker.cleanupExpired(NOW)).resolves.toEqual({
        deleted: 1,
        skipped: 0,
      });
      expect(updates()).toHaveLength(1);
      expect((audit.storage.mock.calls[0] as unknown[])[2]).not.toHaveProperty(
        'size',
      );
    });

    it('skips a row whose file could not be deleted, keeping its key', async () => {
      cleaner.remove.mockImplementation((key: string) =>
        Promise.resolve(key.endsWith('-a') ? 'unavailable' : 'deleted'),
      );
      query
        .mockResolvedValueOnce([expired('a'), expired('b')])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([expired('a')]);

      await expect(worker.cleanupExpired(NOW)).resolves.toEqual({
        deleted: 1,
        skipped: 2,
      });

      expect(updates()).toHaveLength(1);
      expect(updates()[0][1]).toEqual(['b', `${KEY}-b`]);
      expect(audit.storage).toHaveBeenCalledWith(
        'warn',
        'transformation.stored_file.delete',
        expect.objectContaining({ outcome: 'unavailable' }),
      );
    });

    it('stops when nothing in a batch could be removed (no endless retry)', async () => {
      cleaner.remove.mockResolvedValue('unavailable');
      query.mockResolvedValue([expired('a'), expired('b')]);
      await expect(worker.cleanupExpired(NOW)).resolves.toEqual({
        deleted: 0,
        skipped: 2,
      });
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('works in batches until a short batch', async () => {
      cleaner.remove.mockResolvedValue('deleted');
      query
        .mockResolvedValueOnce([expired('a'), expired('b')])
        .mockResolvedValue([])
        .mockResolvedValueOnce([expired('a'), expired('b')])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([expired('c')])
        .mockResolvedValue([]);

      await expect(worker.cleanupExpired(NOW)).resolves.toEqual({
        deleted: 3,
        skipped: 0,
      });
      expect(cleaner.remove).toHaveBeenCalledTimes(3);
    });

    it('is bounded per run', async () => {
      cleaner.remove.mockResolvedValue('deleted');
      query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.trimStart().startsWith('SELECT')
            ? [expired('a'), expired('b')]
            : [],
        ),
      );
      const result = await worker.cleanupExpired(NOW);
      expect(result.deleted).toBe(200);
    });

    it('defaults the clock to now', async () => {
      query.mockResolvedValueOnce([]);
      await worker.cleanupExpired();
      expect((query.mock.calls[0] as [string, Date[]])[1][0]).toBeInstanceOf(
        Date,
      );
    });
  });

  describe('scheduling', () => {
    it('runs both jobs on unref-ed intervals', async () => {
      jest.useFakeTimers();
      query.mockResolvedValue([]);
      worker.onModuleInit();

      await jest.advanceTimersByTimeAsync(1000);
      expect(query).toHaveBeenCalledTimes(1);
      expect((query.mock.calls[0] as string[])[0]).toContain(
        "storage_status = 'pending'",
      );

      await jest.advanceTimersByTimeAsync(4000);
      expect(
        (query.mock.calls as [string][]).some(([sql]) =>
          sql.includes("storage_status = 'available'"),
        ),
      ).toBe(true);
    });

    it('does not start the upload job when disabled', async () => {
      jest.useFakeTimers();
      settings.TRANSFORM_UPLOAD_WORKER_ENABLED = false;
      query.mockResolvedValue([]);
      worker.onModuleInit();
      await jest.advanceTimersByTimeAsync(1000);
      expect(query).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(4000);
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('does not start the cleanup job when disabled', async () => {
      jest.useFakeTimers();
      settings.TRANSFORM_STORED_FILE_CLEANUP_ENABLED = false;
      query.mockResolvedValue([]);
      worker.onModuleInit();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(
        (query.mock.calls as [string][]).every(([sql]) =>
          sql.includes("storage_status = 'pending'"),
        ),
      ).toBe(true);
    });

    it('starts nothing when both are disabled, and stops on destroy', async () => {
      jest.useFakeTimers();
      settings.TRANSFORM_UPLOAD_WORKER_ENABLED = 'false';
      settings.TRANSFORM_STORED_FILE_CLEANUP_ENABLED = 'false';
      worker.onModuleInit();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(query).not.toHaveBeenCalled();
    });

    it('stops the timers on destroy', async () => {
      jest.useFakeTimers();
      query.mockResolvedValue([]);
      worker.onModuleInit();
      worker.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(query).not.toHaveBeenCalled();
    });

    it('swallows a failed run and logs only an event code', async () => {
      jest.useFakeTimers();
      settings.TRANSFORM_STORED_FILE_CLEANUP_ENABLED = false;
      query.mockRejectedValue(new Error('SELECT secret FROM db'));
      worker.onModuleInit();
      await jest.advanceTimersByTimeAsync(1000);
      expect(errorLog).toHaveBeenCalledWith({
        event: 'transformation.stored_file.upload_run_failed',
        category: 'storage',
      });
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('secret');
    });

    it('does not start overlapping runs of the same job', async () => {
      jest.useFakeTimers();
      settings.TRANSFORM_STORED_FILE_CLEANUP_ENABLED = false;
      let release: (rows: unknown[]) => void = () => undefined;
      query.mockImplementation(
        () => new Promise<unknown[]>((resolve) => (release = resolve)),
      );
      worker.onModuleInit();
      await jest.advanceTimersByTimeAsync(3000);
      expect(query).toHaveBeenCalledTimes(1);
      release([]);
    });
  });
});
