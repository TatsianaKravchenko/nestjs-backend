import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';

import { TempStorageService } from './temp-storage.service';

describe('TempStorageService', () => {
  let base: string;
  let service: TempStorageService;
  let env: Record<string, unknown>;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'temp-storage-spec-'));
    env = {
      TRANSFORM_TEMP_DIR: join(base, 'area'),
      TRANSFORM_TEMP_SWEEP_MAX_AGE_MS: 60000,
    };
    service = new TempStorageService({
      get: (key: string) => env[key],
    } as never);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('creates the private area and a job directory with server-chosen names', async () => {
    const workspace = await service.create();

    expect(dirname(dirname(workspace.inputPath))).toBe(service.baseDir());
    expect(basename(dirname(workspace.inputPath))).toMatch(/^job-/);
    expect(basename(workspace.inputPath)).toBe('input.bin');
    expect(basename(workspace.outputPath)).toBe('output.bin');
    expect(dirname(workspace.inputPath)).toBe(dirname(workspace.outputPath));
    if (process.platform !== 'win32') {
      expect((await stat(service.baseDir())).mode & 0o777).toBe(0o700);
    }
  });

  it('gives every job its own directory', async () => {
    const a = await service.create();
    const b = await service.create();
    expect(dirname(a.inputPath)).not.toBe(dirname(b.inputPath));
  });

  it('disposes the directory with its files, and again without error', async () => {
    const workspace = await service.create();
    await writeFile(workspace.inputPath, 'x');
    await writeFile(workspace.outputPath, 'y');

    await workspace.dispose();
    await workspace.dispose();

    expect(await readdir(service.baseDir())).toEqual([]);
  });

  it('defaults to a directory under the OS temp dir', () => {
    env = {};
    expect(service.baseDir()).toBe(join(tmpdir(), 'mnt-transformations'));
  });

  it('probe is true when the area is writable and leaves nothing behind', async () => {
    await expect(service.probe()).resolves.toBe(true);
    expect(await readdir(service.baseDir())).toEqual([]);
  });

  it('probe is false when the area cannot be created', async () => {
    await writeFile(join(base, 'file'), 'x');
    env.TRANSFORM_TEMP_DIR = join(base, 'file', 'nested');
    await expect(service.probe()).resolves.toBe(false);
  });

  describe('sweep', () => {
    it('removes old job directories and keeps recent ones and foreign entries', async () => {
      await mkdir(service.baseDir(), { recursive: true });
      const old = join(service.baseDir(), 'job-old');
      const recent = join(service.baseDir(), 'job-recent');
      const foreign = join(service.baseDir(), 'other-old');
      for (const dir of [old, recent, foreign]) await mkdir(dir);
      const past = new Date(Date.now() - 3600_000);
      await utimes(old, past, past);
      await utimes(foreign, past, past);

      await expect(service.sweep()).resolves.toBe(1);

      expect((await readdir(service.baseDir())).sort()).toEqual([
        'job-recent',
        'other-old',
      ]);
    });

    it('is a no-op while the area does not exist yet', async () => {
      await expect(service.sweep()).resolves.toBe(0);
    });

    it('runs at startup and never fails it', async () => {
      await writeFile(join(base, 'file'), 'x');
      env.TRANSFORM_TEMP_DIR = join(base, 'file');
      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('falls back to one hour for an invalid age', async () => {
      env.TRANSFORM_TEMP_SWEEP_MAX_AGE_MS = 'nope';
      await mkdir(join(service.baseDir(), 'job-fresh'), { recursive: true });
      await expect(service.sweep()).resolves.toBe(0);
    });
  });
});
