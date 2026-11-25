import { HistoryRetentionWorker } from './history-retention.worker';

const NOW = new Date('2026-04-01T00:00:00.000Z');
const settings: Record<string, unknown> = {
  TRANSFORM_HISTORY_RETENTION_DAYS: 90,
  TRANSFORM_HISTORY_CLEANUP_BATCH_SIZE: 2,
  TRANSFORM_HISTORY_CLEANUP_ENABLED: true,
  TRANSFORM_HISTORY_CLEANUP_INTERVAL_MS: 1000,
};

describe('HistoryRetentionWorker', () => {
  const query = jest.fn();
  const cleaner = { remove: jest.fn() };
  const audit = { info: jest.fn(), error: jest.fn() };
  const config = { get: (key: string) => settings[key] };
  let worker: HistoryRetentionWorker;

  beforeEach(() => {
    jest.resetAllMocks();
    settings.TRANSFORM_HISTORY_CLEANUP_ENABLED = true;
    worker = new HistoryRetentionWorker(
      { query } as never,
      config as never,
      audit as never,
      cleaner as never,
    );
  });

  afterEach(() => {
    worker.onModuleDestroy();
    jest.useRealTimers();
  });

  const deletes = (): [string, unknown[]][] =>
    (query.mock.calls as [string, unknown[]][]).filter(([sql]) =>
      sql.startsWith('DELETE'),
    );

  it('selects rows older than 90 days, oldest first, in batches', async () => {
    query.mockResolvedValueOnce([]);
    await expect(worker.run(NOW)).resolves.toEqual({ deleted: 0, skipped: 0 });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('created_at < $1');
    expect(sql).toContain('ORDER BY created_at ASC');
    expect(params[0]).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    expect(params[1]).toBe(2);
    expect(audit.info).not.toHaveBeenCalled();
  });

  it('honours a configured retention period', async () => {
    settings.TRANSFORM_HISTORY_RETENTION_DAYS = 30;
    query.mockResolvedValueOnce([]);
    await worker.run(NOW);
    expect((query.mock.calls[0] as [string, Date[]])[1][0]).toEqual(
      new Date('2026-03-02T00:00:00.000Z'),
    );
    settings.TRANSFORM_HISTORY_RETENTION_DAYS = 90;
  });

  it('deletes the stored file before the row, and keeps going until a short batch', async () => {
    const order: string[] = [];
    query
      .mockResolvedValueOnce([
        { id: 'a', storageKey: 'ka' },
        { id: 'b', storageKey: null },
      ])
      .mockImplementationOnce(() => {
        order.push('delete-rows-1');
        return Promise.resolve([]);
      })
      .mockResolvedValueOnce([{ id: 'c', storageKey: 'kc' }])
      .mockImplementationOnce(() => {
        order.push('delete-rows-2');
        return Promise.resolve([]);
      });
    cleaner.remove.mockImplementation((key: string) => {
      order.push(`object:${key}`);
      return Promise.resolve('deleted');
    });

    await expect(worker.run(NOW)).resolves.toEqual({ deleted: 3, skipped: 0 });

    expect(order).toEqual([
      'object:ka',
      'delete-rows-1',
      'object:kc',
      'delete-rows-2',
    ]);
    expect(deletes()[0][1]).toEqual([['a', 'b']]);
    expect(audit.info).toHaveBeenCalledWith(
      'transformations.history.cleanup',
      expect.objectContaining({ deleted: 3, skipped: 0, result: 'success' }),
    );
  });

  it('treats a missing storage object as already cleaned', async () => {
    query
      .mockResolvedValueOnce([{ id: 'a', storageKey: 'gone' }])
      .mockResolvedValueOnce([]);
    cleaner.remove.mockResolvedValue('not_found');
    await expect(worker.run(NOW)).resolves.toEqual({ deleted: 1, skipped: 0 });
    expect(deletes()[0][1]).toEqual([['a']]);
  });

  it('keeps a row whose file could not be deleted, and deletes the others', async () => {
    query
      .mockResolvedValueOnce([
        { id: 'a', storageKey: 'bad' },
        { id: 'b', storageKey: 'ok' },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'a', storageKey: 'bad' }]);
    cleaner.remove.mockImplementation((key: string) =>
      Promise.resolve(key === 'bad' ? 'unavailable' : 'deleted'),
    );
    const result = await worker.run(NOW);
    expect(result).toEqual({ deleted: 1, skipped: 2 });
    expect(deletes()[0][1]).toEqual([['b']]);
    expect(audit.info).toHaveBeenCalledWith(
      'transformations.history.cleanup',
      expect.objectContaining({ result: 'partial' }),
    );
  });

  it('stops when nothing in a batch could be removed (no endless retry)', async () => {
    query.mockResolvedValue([
      { id: 'a', storageKey: 'bad' },
      { id: 'b', storageKey: 'bad' },
    ]);
    cleaner.remove.mockResolvedValue('unavailable');
    await expect(worker.run(NOW)).resolves.toEqual({ deleted: 0, skipped: 2 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(deletes()).toHaveLength(0);
  });

  it('never logs storage keys', async () => {
    query
      .mockResolvedValueOnce([{ id: 'a', storageKey: 'SECRET-KEY-123' }])
      .mockResolvedValueOnce([]);
    cleaner.remove.mockResolvedValue('deleted');
    await worker.run(NOW);
    expect(JSON.stringify(audit.info.mock.calls)).not.toContain('SECRET');
  });

  describe('scheduling', () => {
    it('runs on an unref-ed interval and logs a failed run without throwing', async () => {
      jest.useFakeTimers();
      query.mockRejectedValue(new Error('db down'));
      worker.onModuleInit();
      await jest.advanceTimersByTimeAsync(1000);
      expect(audit.error).toHaveBeenCalledWith(
        'transformations.history.cleanup_failed',
        { result: 'error' },
      );
    });

    it('does not start overlapping runs', async () => {
      jest.useFakeTimers();
      let release: (rows: unknown[]) => void = () => undefined;
      query.mockImplementation(
        () => new Promise<unknown[]>((resolve) => (release = resolve)),
      );
      worker.onModuleInit();
      await jest.advanceTimersByTimeAsync(3000);
      expect(query).toHaveBeenCalledTimes(1);
      release([]);
    });

    it('does not start when disabled', async () => {
      jest.useFakeTimers();
      settings.TRANSFORM_HISTORY_CLEANUP_ENABLED = false;
      worker.onModuleInit();
      await jest.advanceTimersByTimeAsync(5000);
      expect(query).not.toHaveBeenCalled();
    });
  });
});
