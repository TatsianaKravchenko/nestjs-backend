import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { LocalResultStore } from './local-result-store';

const KEY = 'Abcdefghijklmnopqrstuvwxyz012345';

describe('LocalResultStore', () => {
  let base: string;
  let store: LocalResultStore;
  let source: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'result-store-spec-'));
    store = new LocalResultStore({
      get: (key: string) =>
        key === 'TRANSFORM_STORAGE_DIR' ? join(base, 'store') : undefined,
    } as never);
    source = join(base, 'output.bin');
    await writeFile(source, 'result');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('retains a copy for the background write, leaving the source alone', async () => {
    await store.retain(KEY, source);

    expect(await readFile(join(base, 'store', 'pending', KEY), 'utf8')).toBe(
      'result',
    );
    expect(await readFile(source, 'utf8')).toBe('result');
  });

  it('refuses a key that is not an opaque token', async () => {
    await expect(store.retain('../escape', source)).rejects.toThrow(
      'invalid_key',
    );
    await expect(store.retain('short', source)).rejects.toThrow('invalid_key');
  });

  it('does not overwrite an existing copy', async () => {
    await store.retain(KEY, source);
    await expect(store.retain(KEY, source)).rejects.toMatchObject({
      code: 'EEXIST',
    });
  });

  it('fails when the source is missing', async () => {
    await expect(
      store.retain(KEY, join(base, 'missing')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('deletes the pending copy and a written object; repeating is a success', async () => {
    await store.retain(KEY, source);
    await expect(store.delete(KEY)).resolves.toBe('deleted');

    await mkdir(join(base, 'store', 'objects'), { recursive: true });
    await writeFile(join(base, 'store', 'objects', KEY), 'x');
    await expect(store.delete(KEY)).resolves.toBe('deleted');

    await expect(store.delete(KEY)).resolves.toBe('not_found');
  });

  it('treats a key that would leave the base directory as missing', async () => {
    await expect(store.delete('../../etc/passwd')).resolves.toBe('not_found');
  });

  it('reports unavailable when the store itself fails', async () => {
    // A directory where the file is expected: unlink fails with EISDIR/EPERM.
    await mkdir(join(base, 'store', 'pending', KEY), { recursive: true });
    await expect(store.delete(KEY)).resolves.toBe('unavailable');
  });

  it('defaults the base directory', () => {
    const fallback = new LocalResultStore({ get: () => undefined } as never);
    return expect(fallback.delete('../x')).resolves.toBe('not_found');
  });
});
