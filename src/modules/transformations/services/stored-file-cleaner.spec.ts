import { StoredFileCleaner } from './stored-file-cleaner';

describe('StoredFileCleaner', () => {
  const staging = { remove: jest.fn() };
  const storage = { delete: jest.fn() };
  const cleaner = new StoredFileCleaner(staging as never, storage as never);

  beforeEach(() => jest.resetAllMocks());

  it.each(['deleted', 'not_found'] as const)(
    'returns %s when both are gone',
    async (result) => {
      staging.remove.mockResolvedValue(true);
      storage.delete.mockResolvedValue(result);
      await expect(cleaner.remove('k')).resolves.toBe(result);
      expect(staging.remove).toHaveBeenCalledWith('k');
      expect(storage.delete).toHaveBeenCalledWith('k');
    },
  );

  it('is unavailable when the staged copy cannot be removed, but still deletes the object', async () => {
    staging.remove.mockResolvedValue(false);
    storage.delete.mockResolvedValue('deleted');
    await expect(cleaner.remove('k')).resolves.toBe('unavailable');
    expect(storage.delete).toHaveBeenCalledWith('k');
  });

  it('is unavailable when the storage is unavailable', async () => {
    staging.remove.mockResolvedValue(true);
    storage.delete.mockResolvedValue('unavailable');
    await expect(cleaner.remove('k')).resolves.toBe('unavailable');
  });
});
