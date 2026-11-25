import { Logger } from '@nestjs/common';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Readable } from 'stream';

import { LocalObjectStorage } from './local-object-storage';
import {
  ObjectNotFoundError,
  StoragePermanentError,
  StorageUnavailableError,
} from './object-storage';

jest.mock('fs/promises', () => {
  const actual =
    jest.requireActual<typeof import('fs/promises')>('fs/promises');
  return { ...actual, stat: jest.fn(actual.stat) };
});

const KEY = 'AbCdEfGh01234567-_xyz';

const readAll = async (stream: Readable): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

describe('LocalObjectStorage', () => {
  let base: string;
  let source: string;
  let dir: string | undefined;
  let storage: LocalObjectStorage;
  let errorLog: jest.SpyInstance;

  const objects = (): string => join(dir as string, 'objects');

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'local-storage-'));
    source = join(base, 'source.bin');
    await writeFile(source, 'hello');
    dir = join(base, 'store');
    storage = new LocalObjectStorage({ get: () => dir } as never);
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(base, { recursive: true, force: true });
  });

  it('saves, reads and deletes an object', async () => {
    await storage.save(KEY, source);
    const object = await storage.read(KEY);
    expect(object.size).toBe(5);
    expect(await readAll(object.stream)).toBe('hello');
    await expect(storage.delete(KEY)).resolves.toBe('deleted');
    await expect(storage.read(KEY)).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(storage.delete(KEY)).resolves.toBe('not_found');
  });

  it('is idempotent: saving the same key again replaces the object and leaves no partial file', async () => {
    await storage.save(KEY, source);
    await writeFile(source, 'second');
    await storage.save(KEY, source);
    expect(await readAll((await storage.read(KEY)).stream)).toBe('second');
    expect(await readdir(objects())).toEqual([KEY]);
  });

  it('falls back to the default directory when none is configured', async () => {
    dir = undefined;
    await expect(storage.delete(KEY)).resolves.toBe('not_found');
  });

  it.each(['../evil', 'short', 'a/b/c/d/e/f/g/h/i/j', '', `${KEY}/..`])(
    'never touches the disk for the key %p',
    async (key) => {
      await expect(storage.save(key, source)).rejects.toBeInstanceOf(
        StoragePermanentError,
      );
      await expect(storage.read(key)).rejects.toBeInstanceOf(
        ObjectNotFoundError,
      );
      await expect(storage.delete(key)).resolves.toBe('not_found');
      await expect(stat(dir as string)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('maps a missing source to storage_unavailable without logging paths or keys', async () => {
    await expect(
      storage.save(KEY, join(base, 'missing.bin')),
    ).rejects.toBeInstanceOf(StorageUnavailableError);
    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).toContain('ENOENT');
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain('missing.bin');
    expect(await readdir(objects())).toEqual([]);
  });

  it('reports unavailable for a delete that fails for another reason, logging only the errno', async () => {
    // A directory under the key makes unlink fail with something other than ENOENT.
    await mkdir(join(objects(), KEY), { recursive: true });
    await expect(storage.delete(KEY)).resolves.toBe('unavailable');
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(KEY);
  });

  it('treats ENOTDIR as not found', async () => {
    await mkdir(dir as string, { recursive: true });
    await writeFile(objects(), 'a file where the directory should be');
    await expect(storage.read(KEY)).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(storage.delete(KEY)).resolves.toBe('not_found');
  });

  it('maps an unexpected stat error to storage_unavailable without logging its message', async () => {
    const failure = Object.assign(new Error('boom /secret/path'), {
      code: 'EIO',
    });
    jest.mocked(stat).mockRejectedValueOnce(failure);
    await expect(storage.read(KEY)).rejects.toBeInstanceOf(
      StorageUnavailableError,
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('secret');
  });
});
