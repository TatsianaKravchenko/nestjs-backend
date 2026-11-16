/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access */
import { User, UserStatus } from '../../entities/user.entity';
import {
  DELETION_RETRY_DELAY_MS,
  DeletionJob,
  DeletionJobStatus,
} from '../entities/deletion-job.entity';
import type { EraseResult, UserEraser } from './user-eraser';
import { UserEraserRegistry } from './user-eraser.registry';
import { DeletionWorker } from './deletion-worker.service';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const USER_ID = '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44';
const JOB_ID = 'a'.repeat(32);

const erasers = (...results: (EraseResult | Error)[]): UserEraser[] =>
  results.map((result, i) => ({
    store: `store.${i}`,
    erase: jest.fn(() =>
      result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve(result),
    ),
  }));
const ok: EraseResult = { status: 'succeeded' };

function setup(
  options: {
    env?: Record<string, string>;
    erasers?: UserEraser[];
    job?: Partial<DeletionJob> | null;
    user?: Partial<User> | null;
    current?: Partial<DeletionJob> | null;
  } = {},
) {
  const env: Record<string, string> = {
    DELETION_WORKER_ENABLED: 'true',
    DELETION_WORKER_INTERVAL_MS: '1000',
    DELETION_WORKER_LEASE_SECONDS: '300',
    ...options.env,
  };
  const claimed =
    options.job === null
      ? null
      : ({
          id: JOB_ID,
          userId: USER_ID,
          status: DeletionJobStatus.QUEUED,
          attempts: 0,
          leaseUntil: null,
          ...options.job,
        } as DeletionJob);
  const getOne = jest.fn();
  getOne.mockResolvedValueOnce(claimed);
  getOne.mockResolvedValue(null);
  const builder: Record<string, jest.Mock> = {};
  for (const name of ['setLock', 'setOnLocked', 'where', 'orderBy', 'limit']) {
    builder[name] = jest.fn(() => builder);
  }
  builder.getOne = getOne;

  const user =
    options.user === null
      ? null
      : ({
          id: USER_ID,
          status: UserStatus.DELETING,
          photoKey: null,
          ...options.user,
        } as User);
  const current =
    options.current === null
      ? null
      : ({
          id: JOB_ID,
          status: DeletionJobStatus.RUNNING,
          attempts: 1,
          tombstoneEmail: 'deleted-x@example.invalid',
          ...options.current,
        } as DeletionJob);
  const manager = {
    createQueryBuilder: jest.fn(() => builder),
    save: jest.fn((entity: unknown) => Promise.resolve(entity)),
    findOne: jest.fn((entity: unknown) =>
      Promise.resolve(entity === User ? user : current),
    ),
    update: jest.fn(),
    query: jest.fn(),
  };
  const failSet = jest.fn();
  const failChain = {
    update: jest.fn(() => failChain),
    set: failSet.mockImplementation(() => failChain),
    where: jest.fn(() => failChain),
    execute: jest.fn(),
  };
  const dataSource = {
    transaction: jest.fn((work: (m: typeof manager) => unknown) =>
      Promise.resolve(work(manager)),
    ),
    createQueryBuilder: jest.fn(() => failChain),
  };
  const audit = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const registry = new UserEraserRegistry();
  for (const eraser of options.erasers ?? erasers(ok)) {
    registry.register(eraser);
  }
  const storage = {
    read: jest.fn().mockResolvedValue({ status: 'not_found' }),
  };
  const worker = new DeletionWorker(
    dataSource as never,
    { get: (key: string) => env[key] } as never,
    audit as never,
    registry,
    storage as never,
  );
  return {
    worker,
    manager,
    dataSource,
    audit,
    storage,
    failSet,
    claimed,
    current,
  };
}

describe('DeletionWorker', () => {
  afterEach(() => jest.useRealTimers());

  describe('claim', () => {
    it('does nothing when no job is due', async () => {
      const { worker, manager } = setup({ job: null });
      await expect(worker.processDue(NOW)).resolves.toBe(0);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('marks the job running with a lease and counts the attempt', async () => {
      const { worker, claimed } = setup({
        erasers: erasers({ status: 'retryable_failure', code: 'x' }),
      });
      await worker.processDue(NOW);
      expect(claimed?.status).toBe(DeletionJobStatus.RUNNING);
      expect(claimed?.attempts).toBe(1);
      expect(claimed?.leaseUntil).toEqual(new Date(NOW.getTime() + 300_000));
    });

    it('selects with SKIP LOCKED over queued and lease-expired jobs', async () => {
      const { worker, manager } = setup({ job: null });
      await worker.processDue(NOW);
      const builder = manager.createQueryBuilder.mock.results[0]
        .value as Record<string, jest.Mock>;
      expect(builder.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(builder.setOnLocked).toHaveBeenCalledWith('skip_locked');
      expect(builder.where.mock.calls[0][0]).toContain('job.leaseUntil < :now');
    });
  });

  describe('finalization', () => {
    it('erases, then tombstones the user and marks the job succeeded', async () => {
      const { worker, manager, audit, current } = setup();
      await expect(worker.processDue(NOW)).resolves.toBe(1);

      expect(manager.query).toHaveBeenCalledTimes(4);
      expect(manager.update).toHaveBeenCalledWith(
        User,
        { id: USER_ID },
        {
          email: 'deleted-x@example.invalid',
          displayName: null,
          photoKey: null,
          passwordHash: null,
          status: UserStatus.DELETED,
        },
      );
      expect(current?.status).toBe(DeletionJobStatus.SUCCEEDED);
      expect(current?.leaseUntil).toBeNull();
      expect(audit.info).toHaveBeenCalledWith('users.deletion.job', {
        result: 'succeeded',
      });
    });

    it('finalizes when the photo object is gone', async () => {
      const { worker, manager, storage } = setup({
        user: { photoKey: 'k.webp' },
      });
      await worker.processDue(NOW);
      expect(storage.read).toHaveBeenCalledWith('k.webp');
      expect(manager.update).toHaveBeenCalled();
    });

    it('retries while the photo object is still there and closes the stream', async () => {
      const destroy = jest.fn();
      const { worker, manager, storage, failSet, audit } = setup({
        user: { photoKey: 'k.webp' },
      });
      storage.read.mockResolvedValue({ status: 'found', stream: { destroy } });
      await worker.processDue(NOW);

      expect(destroy).toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
      expect(failSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: DeletionJobStatus.QUEUED,
          lastErrorCode: 'photo_present',
        }),
      );
      expect(audit.warn).toHaveBeenCalledWith('users.deletion.job', {
        result: 'retry',
        errorCode: 'photo_present',
      });
    });

    it('retries while the storage is unavailable', async () => {
      const { worker, storage, failSet } = setup({
        user: { photoKey: 'k.webp' },
      });
      storage.read.mockResolvedValue({ status: 'unavailable' });
      await worker.processDue(NOW);
      expect(failSet).toHaveBeenCalledWith(
        expect.objectContaining({ lastErrorCode: 'storage_unavailable' }),
      );
    });

    it.each([
      [
        'the job is no longer running',
        { user: {}, current: { status: DeletionJobStatus.QUEUED } },
      ],
      ['another run owns the job', { user: {}, current: { attempts: 2 } }],
      ['the job is gone', { user: {}, current: null }],
      ['the user is gone', { user: null }],
      ['the user is not deleting', { user: { status: UserStatus.ACTIVE } }],
    ])('does nothing when %s', async (_name, options) => {
      const { worker, manager, failSet, audit } = setup(options);
      await worker.processDue(NOW);
      expect(manager.update).not.toHaveBeenCalled();
      expect(failSet).not.toHaveBeenCalled();
      expect(audit.info).not.toHaveBeenCalled();
    });

    it('retries after a finalize error', async () => {
      const { worker, manager, failSet } = setup();
      manager.query.mockRejectedValue(new Error('db'));
      await worker.processDue(NOW);
      expect(failSet).toHaveBeenCalledWith(
        expect.objectContaining({ lastErrorCode: 'finalize_error' }),
      );
    });
  });

  describe('failures', () => {
    it('requeues a retryable failure one minute later', async () => {
      const { worker, failSet, manager } = setup({
        erasers: erasers({
          status: 'retryable_failure',
          code: 'storage_unavailable',
        }),
      });
      await worker.processDue(NOW);

      expect(manager.update).not.toHaveBeenCalled();
      expect(failSet).toHaveBeenCalledWith({
        status: DeletionJobStatus.QUEUED,
        leaseUntil: null,
        nextAttemptAt: new Date(NOW.getTime() + DELETION_RETRY_DELAY_MS),
        lastErrorCode: 'storage_unavailable',
      });
    });

    it('fails the job on the 5th run', async () => {
      const { worker, failSet, audit } = setup({
        job: { attempts: 4 },
        erasers: erasers({
          status: 'retryable_failure',
          code: 'storage_unavailable',
        }),
      });
      await worker.processDue(NOW);
      expect(failSet).toHaveBeenCalledWith(
        expect.objectContaining({ status: DeletionJobStatus.FAILED }),
      );
      expect(audit.error).toHaveBeenCalledWith('users.deletion.job', {
        result: 'failed',
        errorCode: 'storage_unavailable',
      });
    });

    it('fails at once on a permanent failure and skips the remaining erasers', async () => {
      const list = erasers({ status: 'permanent_failure', code: 'broken' }, ok);
      const { worker, failSet } = setup({ erasers: list });
      await worker.processDue(NOW);
      expect(failSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: DeletionJobStatus.FAILED,
          lastErrorCode: 'broken',
        }),
      );
      expect(list[1].erase).not.toHaveBeenCalled();
    });

    it('treats a throwing eraser as retryable and still runs the others', async () => {
      const list = erasers(new Error('boom'), ok);
      const { worker, failSet } = setup({ erasers: list });
      await worker.processDue(NOW);
      expect(list[1].erase).toHaveBeenCalled();
      expect(failSet).toHaveBeenCalledWith(
        expect.objectContaining({ lastErrorCode: 'eraser_error' }),
      );
    });

    it('keeps the first retryable code', async () => {
      const { worker, failSet } = setup({
        erasers: erasers(
          { status: 'retryable_failure', code: 'first' },
          { status: 'retryable_failure', code: 'second' },
        ),
      });
      await worker.processDue(NOW);
      expect(failSet).toHaveBeenCalledWith(
        expect.objectContaining({ lastErrorCode: 'first' }),
      );
    });
  });

  describe('timer', () => {
    it('does not start when disabled', () => {
      jest.useFakeTimers();
      const spy = jest.spyOn(global, 'setInterval');
      const { worker } = setup({ env: { DELETION_WORKER_ENABLED: 'false' } });
      worker.onModuleInit();
      expect(spy).not.toHaveBeenCalled();
      worker.onModuleDestroy();
    });

    it('runs due jobs on every tick and stops on destroy', async () => {
      jest.useFakeTimers();
      const { worker } = setup();
      const run = jest.spyOn(worker, 'processDue').mockResolvedValue(0);
      worker.onModuleInit();

      await jest.advanceTimersByTimeAsync(1000);
      expect(run).toHaveBeenCalledTimes(1);
      worker.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(5000);
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('does not overlap runs', async () => {
      jest.useFakeTimers();
      const { worker } = setup();
      let release: () => void = () => undefined;
      const run = jest
        .spyOn(worker, 'processDue')
        .mockImplementation(
          () => new Promise<number>((resolve) => (release = () => resolve(0))),
        );
      worker.onModuleInit();

      await jest.advanceTimersByTimeAsync(3000);
      expect(run).toHaveBeenCalledTimes(1);
      release();
      await jest.advanceTimersByTimeAsync(1000);
      expect(run).toHaveBeenCalledTimes(2);
      worker.onModuleDestroy();
    });

    it('logs a worker error and keeps running', async () => {
      jest.useFakeTimers();
      const { worker, audit } = setup();
      const run = jest
        .spyOn(worker, 'processDue')
        .mockRejectedValueOnce(new Error('db'))
        .mockResolvedValue(0);
      worker.onModuleInit();

      await jest.advanceTimersByTimeAsync(2000);
      expect(audit.error).toHaveBeenCalledWith('users.deletion.worker_error');
      expect(run).toHaveBeenCalledTimes(2);
      worker.onModuleDestroy();
    });
  });
});
