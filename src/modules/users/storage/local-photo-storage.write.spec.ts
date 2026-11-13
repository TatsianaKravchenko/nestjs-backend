import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { ConfigService } from '@/core/config/config.service';

import { LocalPhotoStorage } from './local-photo-storage';

describe('LocalPhotoStorage (write, delete, list)', () => {
  let dir: string;
  let storage: LocalPhotoStorage;

  const make = (path: string) =>
    new LocalPhotoStorage({ get: () => path } as unknown as ConfigService);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'photos-write-'));
    storage = make(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  describe('write', () => {
    it('stores the bytes and leaves no temporary file', async () => {
      await storage.write('a.webp', Buffer.from('bytes'));

      expect((await readFile(join(dir, 'a.webp'))).toString()).toBe('bytes');
      expect(await readdir(dir)).toEqual(['a.webp']);
    });

    it('creates the base directory when it does not exist', async () => {
      const nested = join(dir, 'deep', 'photos');
      await make(nested).write('a.webp', Buffer.from('x'));

      expect(await readdir(nested)).toEqual(['a.webp']);
    });

    it('replaces an existing object', async () => {
      await storage.write('a.webp', Buffer.from('one'));
      await storage.write('a.webp', Buffer.from('two'));

      expect((await readFile(join(dir, 'a.webp'))).toString()).toBe('two');
      expect(await readdir(dir)).toEqual(['a.webp']);
    });

    it.each(['../escape.webp', '', '.'])(
      'refuses the key %j that leaves the base directory',
      async (key) => {
        await expect(storage.write(key, Buffer.from('x'))).rejects.toThrow(
          'invalid_key',
        );
        expect(await readdir(dir)).toEqual([]);
      },
    );

    it('removes the temporary file and rethrows when the final rename fails', async () => {
      // A non-empty directory with the target name makes the rename fail.
      await mkdir(join(dir, 'taken.webp'));
      await writeFile(join(dir, 'taken.webp', 'child'), 'x');

      await expect(
        storage.write('taken.webp', Buffer.from('x')),
      ).rejects.toBeDefined();

      expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual(
        [],
      );
    });
  });

  describe('delete', () => {
    it('deletes an existing object', async () => {
      await writeFile(join(dir, 'a.webp'), 'x');

      await expect(storage.delete('a.webp')).resolves.toBe('deleted');
      expect(await readdir(dir)).toEqual([]);
    });

    it('reports not_found for a missing object, a path below a file and an escaping key', async () => {
      await writeFile(join(dir, 'file'), 'x');

      await expect(storage.delete('missing.webp')).resolves.toBe('not_found');
      await expect(storage.delete('file/child')).resolves.toBe('not_found');
      await expect(storage.delete('../x')).resolves.toBe('not_found');
    });

    it('reports unavailable for any other failure (a directory)', async () => {
      await mkdir(join(dir, 'folder'));

      await expect(storage.delete('folder')).resolves.toBe('unavailable');
    });
  });

  describe('listOlderThan', () => {
    it('lists only files last modified before the cutoff', async () => {
      await writeFile(join(dir, 'old.webp'), 'x');
      await writeFile(join(dir, 'fresh.webp'), 'x');
      await mkdir(join(dir, 'folder'));
      const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
      await utimes(join(dir, 'old.webp'), twoHoursAgo, twoHoursAgo);
      await utimes(join(dir, 'folder'), twoHoursAgo, twoHoursAgo);

      const found = await storage.listOlderThan(
        new Date(Date.now() - 3600_000),
      );

      expect(found.map((o) => o.key)).toEqual(['old.webp']);
      expect(found[0].lastModified.getTime()).toBeLessThan(
        Date.now() - 3600_000,
      );
    });

    it('returns an empty list when the directory does not exist', async () => {
      const missing = make(join(dir, 'nope'));

      await expect(missing.listOlderThan(new Date())).resolves.toEqual([]);
    });

    it('rethrows other read errors', async () => {
      await writeFile(join(dir, 'file'), 'x');

      await expect(
        make(join(dir, 'file')).listOlderThan(new Date()),
      ).rejects.toBeDefined();
    });
  });
});
