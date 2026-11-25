import { HttpException } from '@nestjs/common';
import { Readable } from 'stream';

import { ObjectNotFoundError, StorageUnavailableError } from './object-storage';
import { StoredFileDownloadService } from './stored-file-download.service';

const ACTOR = '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44';
const TARGET = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const ITEM = '00000000-0000-4000-8000-000000000001';
const KEY = 'SECRET-opaque-key-0123456789';

const row = (overrides: Record<string, unknown> = {}) => ({
  status: 'success',
  target_format: 'json',
  storage_status: 'available',
  stored_file_key: KEY,
  stored_file_until: new Date(Date.now() + 86_400_000),
  ...overrides,
});

const statusOf = async (promise: Promise<unknown>): Promise<number> => {
  try {
    await promise;
  } catch (error) {
    return (error as HttpException).getStatus();
  }
  return 200;
};

describe('StoredFileDownloadService', () => {
  const manager = { query: jest.fn() };
  const dataSource = {
    query: jest.fn(),
    transaction: jest.fn((fn: (m: typeof manager) => unknown) => fn(manager)),
  };
  const audit = { storage: jest.fn() };
  const storage = { read: jest.fn() };
  const service = new StoredFileDownloadService(
    dataSource as never,
    audit as never,
    storage as never,
  );
  const ctx = { requestId: 'req-1', actorUserId: ACTOR };
  const stream = Readable.from(['{}']);

  /** The row lookup is the second query of the transaction (after SET LOCAL). */
  const found = (value: unknown) =>
    manager.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(value === undefined ? [] : [value]);

  beforeEach(() => {
    jest.resetAllMocks();
    dataSource.transaction.mockImplementation((fn) => fn(manager));
    storage.read.mockResolvedValue({ stream, size: 2 });
  });

  it('opens the file with the type taken from the target format', async () => {
    found(row());
    await expect(service.open(ctx, ITEM)).resolves.toEqual({
      stream,
      size: 2,
      contentType: 'application/json',
      extension: 'json',
    });
    expect(storage.read).toHaveBeenCalledWith(KEY);
  });

  it.each([
    ['csv', 'text/csv'],
    ['png', 'image/png'],
    ['weird', 'application/octet-stream'],
  ])('target format %s -> %s', async (target_format, contentType) => {
    found(row({ target_format }));
    expect((await service.open(ctx, ITEM)).contentType).toBe(contentType);
  });

  it('looks the item up by BOTH its id and the session user', async () => {
    found(row());
    await service.open(ctx, ITEM);
    const [sql, params] = manager.query.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('id = $1 AND user_id = $2');
    expect(params).toEqual([ITEM, ACTOR]);
    expect((manager.query.mock.calls[0] as string[])[0]).toContain(
      'statement_timeout',
    );
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('the admin route scopes to the target user after checking that it exists', async () => {
    dataSource.query.mockResolvedValue([{ '?column?': 1 }]);
    found(row());
    await service.open({ ...ctx, targetUserId: TARGET }, ITEM);
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM users'),
      [TARGET],
    );
    expect((manager.query.mock.calls[1] as [string, unknown[]])[1]).toEqual([
      ITEM,
      TARGET,
    ]);
  });

  it('the admin route answers 404 for a missing target user, without looking up the item', async () => {
    dataSource.query.mockResolvedValue([]);
    expect(
      await statusOf(service.open({ ...ctx, targetUserId: TARGET }, ITEM)),
    ).toBe(404);
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('the admin route answers 503 when the user lookup fails', async () => {
    dataSource.query.mockRejectedValue(new Error('db down'));
    expect(
      await statusOf(service.open({ ...ctx, targetUserId: TARGET }, ITEM)),
    ).toBe(503);
  });

  it.each([
    ['an id that is not a uuid', 'nope', ACTOR],
    ['a session user that is not a uuid', ITEM, 'nope'],
  ])('404 without a query for %s', async (_label, itemId, actor) => {
    expect(
      await statusOf(service.open({ ...ctx, actorUserId: actor }, itemId)),
    ).toBe(404);
    expect(manager.query).not.toHaveBeenCalled();
    expect(storage.read).not.toHaveBeenCalled();
  });

  it.each([
    ['no row (not found or not the owner)', undefined],
    ['a failed attempt', row({ status: 'error' })],
    ['not requested', row({ storage_status: 'not_requested' })],
    ['a storage error', row({ storage_status: 'error' })],
    ['an available row without a key', row({ stored_file_key: null })],
    ['an available row without an expiry', row({ stored_file_until: null })],
    ['an expired file', row({ stored_file_until: new Date(Date.now() - 1) })],
  ])('404 for %s', async (_label, value) => {
    found(value);
    expect(await statusOf(service.open(ctx, ITEM))).toBe(404);
    expect(storage.read).not.toHaveBeenCalled();
  });

  it('409 file_not_ready while the file is pending', async () => {
    found(row({ storage_status: 'pending' }));
    const error = await service.open(ctx, ITEM).catch((e: unknown) => e);
    expect((error as HttpException).getStatus()).toBe(409);
    expect(JSON.stringify((error as HttpException).getResponse())).toContain(
      'file_not_ready',
    );
  });

  it('503 when the database fails', async () => {
    manager.query.mockRejectedValue(new Error('db down'));
    expect(await statusOf(service.open(ctx, ITEM))).toBe(503);
  });

  it.each([
    [
      'the object is missing although the row has a key',
      new ObjectNotFoundError(),
    ],
    ['the storage is unavailable', new StorageUnavailableError()],
  ])('503 when %s', async (_label, failure) => {
    found(row());
    storage.read.mockRejectedValue(failure);
    const error = await service.open(ctx, ITEM).catch((e: unknown) => e);
    expect((error as HttpException).getStatus()).toBe(503);
    expect(
      JSON.stringify((error as HttpException).getResponse()),
    ).not.toContain(KEY);
  });

  it('503 for an unexpected non-HTTP error', async () => {
    dataSource.transaction.mockImplementation(() => {
      throw new Error('unexpected');
    });
    expect(await statusOf(service.open(ctx, ITEM))).toBe(503);
    expect(audit.storage).toHaveBeenCalledWith(
      'warn',
      'transformation.stored_file.download',
      expect.objectContaining({
        outcome: 'unavailable',
        errorCode: 'storage_unavailable',
      }),
    );
  });

  describe('audit', () => {
    const last = () =>
      audit.storage.mock.calls[audit.storage.mock.calls.length - 1] as [
        string,
        string,
        Record<string, unknown>,
      ];

    it('success: owner, transformation, size, duration; no actor on the own route', async () => {
      found(row());
      await service.open(ctx, ITEM);
      const [level, event, fields] = last();
      expect(level).toBe('log');
      expect(event).toBe('transformation.stored_file.download');
      expect(fields).toMatchObject({
        requestId: 'req-1',
        userId: ACTOR,
        transformationId: ITEM,
        action: 'download',
        outcome: 'success',
        size: 2,
      });
      expect(fields).not.toHaveProperty('actorUserId');
      expect(typeof fields.durationMs).toBe('number');
      expect(JSON.stringify(audit.storage.mock.calls)).not.toContain('SECRET');
    });

    it('admin success names the actor and the target owner', async () => {
      dataSource.query.mockResolvedValue([{}]);
      found(row());
      await service.open({ ...ctx, targetUserId: TARGET }, ITEM);
      expect(last()[2]).toMatchObject({ userId: TARGET, actorUserId: ACTOR });
    });

    it('404 -> not_found at log level', async () => {
      found(undefined);
      await statusOf(service.open(ctx, ITEM));
      expect(last()[0]).toBe('log');
      expect(last()[2]).toMatchObject({ outcome: 'not_found' });
    });

    it('409 -> not_ready at warn level', async () => {
      found(row({ storage_status: 'pending' }));
      await statusOf(service.open(ctx, ITEM));
      expect(last()[0]).toBe('warn');
      expect(last()[2]).toMatchObject({ outcome: 'not_ready' });
    });

    it('503 -> unavailable with a safe code', async () => {
      found(row());
      storage.read.mockRejectedValue(new StorageUnavailableError());
      await statusOf(service.open(ctx, ITEM));
      expect(last()[0]).toBe('warn');
      expect(last()[2]).toMatchObject({
        outcome: 'unavailable',
        errorCode: 'storage_unavailable',
      });
    });

    it('leaves the transformation id out when the id is not a uuid', async () => {
      await statusOf(service.open(ctx, '../../etc/passwd'));
      expect(last()[2]).not.toHaveProperty('transformationId');
    });
  });
});
