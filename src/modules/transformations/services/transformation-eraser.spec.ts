import { UserEraserRegistry } from '@/modules/users/deletion/services/user-eraser.registry';
import { USER_DATA_STORES } from '@/modules/users/deletion/services/user-eraser';

import { TransformationEraser } from './transformation-eraser';

const USER_ID = '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44';

describe('TransformationEraser', () => {
  const query = jest.fn();
  const results = { delete: jest.fn() };
  const registry = new UserEraserRegistry();
  const eraser = new TransformationEraser(
    { query } as never,
    registry,
    results as never,
  );

  beforeEach(() => jest.resetAllMocks());

  it('registers itself under a store the deletion worker requires', () => {
    eraser.onModuleInit();
    expect(registry.all()).toContain(eraser);
    expect(USER_DATA_STORES).toContain(eraser.store);
  });

  it('succeeds without a lookup for a non-uuid id', async () => {
    await expect(eraser.erase('nope')).resolves.toEqual({
      status: 'succeeded',
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('deletes the stored objects first, then the history rows', async () => {
    const order: string[] = [];
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT')) {
        order.push('select');
        return Promise.resolve([{ storageKey: 'k1' }, { storageKey: 'k2' }]);
      }
      order.push('delete-rows');
      return Promise.resolve([]);
    });
    results.delete.mockImplementation((key: string) => {
      order.push(`object:${key}`);
      return Promise.resolve('deleted');
    });

    await expect(eraser.erase(USER_ID)).resolves.toEqual({
      status: 'succeeded',
    });

    expect(order).toEqual(['select', 'object:k1', 'object:k2', 'delete-rows']);
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('DELETE FROM transformations WHERE user_id'),
      [USER_ID],
    );
  });

  it('a missing object counts as deleted', async () => {
    query.mockResolvedValueOnce([{ storageKey: 'gone' }]).mockResolvedValue([]);
    results.delete.mockResolvedValue('not_found');

    await expect(eraser.erase(USER_ID)).resolves.toEqual({
      status: 'succeeded',
    });
  });

  it('keeps the history rows and asks for a retry while the storage is unavailable', async () => {
    query.mockResolvedValueOnce([{ storageKey: 'a' }, { storageKey: 'b' }]);
    results.delete
      .mockResolvedValueOnce('unavailable')
      .mockResolvedValueOnce('deleted');

    await expect(eraser.erase(USER_ID)).resolves.toEqual({
      status: 'retryable_failure',
      code: 'storage_unavailable',
    });

    expect(results.delete).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a user without data succeeds', async () => {
    query.mockResolvedValue([]);

    await expect(eraser.erase(USER_ID)).resolves.toEqual({
      status: 'succeeded',
    });
    await expect(eraser.erase(USER_ID)).resolves.toEqual({
      status: 'succeeded',
    });
    expect(results.delete).not.toHaveBeenCalled();
  });

  it('lets a database error through for the worker to retry', async () => {
    query.mockRejectedValue(new Error('down'));
    await expect(eraser.erase(USER_ID)).rejects.toThrow('down');
  });
});
