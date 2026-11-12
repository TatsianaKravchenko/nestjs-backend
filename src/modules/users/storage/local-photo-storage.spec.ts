import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { ConfigService } from '@/core/config/config.service';

import { LocalPhotoStorage } from './local-photo-storage';

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString();
}

describe('LocalPhotoStorage', () => {
  let dir: string;
  let storage: LocalPhotoStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'photos-'));
    storage = new LocalPhotoStorage({
      get: () => dir,
    } as unknown as ConfigService);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('streams an existing object', async () => {
    await writeFile(join(dir, 'a.webp'), 'webp-bytes');

    const result = await storage.read('a.webp');

    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(await readAll(result.stream)).toBe('webp-bytes');
    }
  });

  it('reports not_found for a missing object', async () => {
    await expect(storage.read('missing.webp')).resolves.toEqual({
      status: 'not_found',
    });
  });

  it('reports not_found for a directory and for a path through a file', async () => {
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'file'), 'x');

    await expect(storage.read('sub')).resolves.toEqual({
      status: 'not_found',
    });
    await expect(storage.read('file/child')).resolves.toEqual({
      status: 'not_found',
    });
  });

  it.each(['../outside.webp', '../../etc/passwd', '', '.'])(
    'never leaves the base directory: %j',
    async (key) => {
      await expect(storage.read(key)).resolves.toEqual({
        status: 'not_found',
      });
    },
  );

  it('rejects an absolute key outside the base directory', async () => {
    const outside = join(tmpdir(), 'outside-photo.webp');
    await writeFile(outside, 'secret');
    try {
      await expect(storage.read(outside)).resolves.toEqual({
        status: 'not_found',
      });
    } finally {
      await rm(outside, { force: true });
    }
  });

  it('reports unavailable on an unexpected filesystem error', async () => {
    // A NUL byte makes fs throw ERR_INVALID_ARG_VALUE, not ENOENT.
    await expect(storage.read('a\0b')).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('falls back to ./storage when no directory is configured', async () => {
    const fallback = new LocalPhotoStorage({
      get: () => '',
    } as unknown as ConfigService);

    await expect(fallback.read('definitely-missing.webp')).resolves.toEqual({
      status: 'not_found',
    });
  });
});
