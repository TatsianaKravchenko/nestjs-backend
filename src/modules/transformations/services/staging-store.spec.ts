import { Logger } from '@nestjs/common';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { StagingStore } from './staging-store';

const KEY = 'AbCdEfGh01234567-_xyz';

describe('StagingStore', () => {
  let base: string;
  let source: string;
  let dir: string;
  let store: StagingStore;
  let errorLog: jest.SpyInstance;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'staging-'));
    source = join(base, 'source.bin');
    await writeFile(source, 'hello');
    dir = join(base, 'store');
    store = new StagingStore({ get: () => dir } as never);
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(base, { recursive: true, force: true });
  });

  it('stages a copy under the key and returns its path', async () => {
    await store.stage(KEY, source);
    const path = store.pathOf(KEY);
    expect(path).toBe(join(dir, 'pending', KEY));
    expect(await readFile(path as string, 'utf8')).toBe('hello');
  });

  it('refuses to overwrite an existing staged copy', async () => {
    await store.stage(KEY, source);
    await expect(store.stage(KEY, source)).rejects.toMatchObject({
      code: 'EEXIST',
    });
  });

  it('rejects an invalid key without touching the disk', async () => {
    await expect(store.stage('../x', source)).rejects.toThrow('invalid_key');
    expect(store.pathOf('../x')).toBeNull();
    await expect(store.remove('../x')).resolves.toBe(true);
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes a staged copy, and a missing one counts as removed', async () => {
    await store.stage(KEY, source);
    await expect(store.remove(KEY)).resolves.toBe(true);
    await expect(stat(store.pathOf(KEY) as string)).rejects.toBeDefined();
    await expect(store.remove(KEY)).resolves.toBe(true);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('reports a real failure without logging the key or the path', async () => {
    await mkdir(join(dir, 'pending', KEY), { recursive: true });
    await expect(store.remove(KEY)).resolves.toBe(false);
    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).toContain('transformation.staging_cleanup_failed');
    expect(logged).not.toContain(KEY);
  });

  it('uses the default directory when none is configured', () => {
    dir = '';
    expect(store.pathOf(KEY)).toMatch(/storage[\\/]transformations/);
  });
});
