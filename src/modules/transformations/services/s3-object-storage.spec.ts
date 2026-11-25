import { Logger } from '@nestjs/common';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';

import {
  ObjectNotFoundError,
  StoragePermanentError,
  StorageUnavailableError,
} from './object-storage';
import { S3ObjectStorage } from './s3-object-storage';

const send = jest.fn();
const clientConfigs: unknown[] = [];
const uploadDone = jest.fn();
const uploadParams: { Bucket: string; Key: string; Body: Readable }[] = [];

jest.mock('@aws-sdk/client-s3', () => ({
  ...jest.requireActual<object>('@aws-sdk/client-s3'),
  S3Client: jest.fn().mockImplementation((config: unknown) => {
    clientConfigs.push(config);
    return { send };
  }),
}));
jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest
    .fn()
    .mockImplementation(
      (options: {
        params: { Bucket: string; Key: string; Body: Readable };
      }) => {
        uploadParams.push(options.params);
        return { done: uploadDone };
      },
    ),
}));

const KEY = 'AbCdEfGh01234567-_xyz';
const SECRET_BUCKET = 'secret-bucket-name';

const settings: Record<string, unknown> = {};
const config = { get: (name: string) => settings[name] };

const s3Error = (name: string, status?: number): Error =>
  Object.assign(new Error('raw sdk message with secret-bucket-name'), {
    name,
    ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } }),
  });

describe('S3ObjectStorage', () => {
  let base: string;
  let source: string;
  let storage: S3ObjectStorage;
  let errorLog: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    clientConfigs.length = 0;
    uploadParams.length = 0;
    Object.assign(settings, {
      TRANSFORM_S3_BUCKET: SECRET_BUCKET,
      TRANSFORM_S3_REGION: 'eu-west-1',
      TRANSFORM_S3_ENDPOINT: 'http://minio:9000',
      TRANSFORM_S3_FORCE_PATH_STYLE: 'true',
      TRANSFORM_S3_ACCESS_KEY_ID: 'AKID',
      TRANSFORM_S3_SECRET_ACCESS_KEY: 'SECRETKEY',
    });
    base = await mkdtemp(join(tmpdir(), 's3-storage-'));
    source = join(base, 'source.bin');
    await writeFile(source, 'hello');
    storage = new S3ObjectStorage(config as never);
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(base, { recursive: true, force: true });
  });

  it('configures the client from the settings', () => {
    expect(clientConfigs[0]).toEqual({
      region: 'eu-west-1',
      endpoint: 'http://minio:9000',
      forcePathStyle: true,
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRETKEY' },
    });
  });

  it('uses defaults and the ambient credentials when nothing is configured', () => {
    Object.assign(settings, {
      TRANSFORM_S3_REGION: '',
      TRANSFORM_S3_ENDPOINT: '',
      TRANSFORM_S3_FORCE_PATH_STYLE: false,
      TRANSFORM_S3_ACCESS_KEY_ID: '',
      TRANSFORM_S3_SECRET_ACCESS_KEY: '',
    });
    new S3ObjectStorage(config as never);
    expect(clientConfigs[1]).toEqual({
      region: 'us-east-1',
      endpoint: undefined,
      forcePathStyle: false,
    });
  });

  describe('save', () => {
    it('uploads the file under the key, without an ACL', async () => {
      uploadDone.mockResolvedValue({});
      await storage.save(KEY, source);
      expect(uploadParams[0]).toMatchObject({
        Bucket: SECRET_BUCKET,
        Key: KEY,
      });
      expect(uploadParams[0]).not.toHaveProperty('ACL');
    });

    it('is idempotent: the same key can be saved again', async () => {
      uploadDone.mockResolvedValue({});
      await storage.save(KEY, source);
      await storage.save(KEY, source);
      expect(uploadParams.map((p) => p.Key)).toEqual([KEY, KEY]);
    });

    it('rejects an invalid key without an upload', async () => {
      await expect(storage.save('../x', source)).rejects.toBeInstanceOf(
        StoragePermanentError,
      );
      expect(uploadParams).toHaveLength(0);
    });

    it.each([400, 401, 403, 404, 405, 413])(
      'status %i is a permanent failure',
      async (status) => {
        uploadDone.mockRejectedValue(s3Error('AccessDenied', status));
        const error = await storage.save(KEY, source).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(StoragePermanentError);
        expect((error as StoragePermanentError).code).toBe('storage_rejected');
        expect((error as Error).message).not.toContain(SECRET_BUCKET);
        expect(uploadParams[0].Body.destroyed).toBe(true);
      },
    );

    it.each([500, 502, 503, 429])(
      'status %i is unavailable (retry)',
      async (status) => {
        uploadDone.mockRejectedValue(s3Error('InternalError', status));
        await expect(storage.save(KEY, source)).rejects.toBeInstanceOf(
          StorageUnavailableError,
        );
      },
    );

    it('a network error without a status is unavailable, and only its name is logged', async () => {
      uploadDone.mockRejectedValue(s3Error('TimeoutError'));
      await expect(storage.save(KEY, source)).rejects.toBeInstanceOf(
        StorageUnavailableError,
      );
      const logged = JSON.stringify(errorLog.mock.calls);
      expect(logged).toContain('TimeoutError');
      expect(logged).not.toContain(SECRET_BUCKET);
      expect(logged).not.toContain(KEY);
      expect(logged).not.toContain('SECRETKEY');
    });

    it('an error without a name is logged as unknown', async () => {
      uploadDone.mockRejectedValue({});
      await expect(storage.save(KEY, source)).rejects.toBeInstanceOf(
        StorageUnavailableError,
      );
      expect(JSON.stringify(errorLog.mock.calls)).toContain('unknown');
    });
  });

  describe('read', () => {
    it('returns the body stream and its size', async () => {
      const body = Readable.from(['hello']);
      send.mockResolvedValue({ Body: body, ContentLength: 5 });
      const object = await storage.read(KEY);
      expect(object.stream).toBe(body);
      expect(object.size).toBe(5);
      expect((send.mock.calls[0] as [{ input: unknown }])[0].input).toEqual({
        Bucket: SECRET_BUCKET,
        Key: KEY,
      });
    });

    it('size is 0 when the length is unknown', async () => {
      send.mockResolvedValue({ Body: Readable.from([]) });
      expect((await storage.read(KEY)).size).toBe(0);
    });

    it('a body that is not a stream is unavailable', async () => {
      send.mockResolvedValue({ Body: undefined });
      await expect(storage.read(KEY)).rejects.toBeInstanceOf(
        StorageUnavailableError,
      );
    });

    it.each([
      ['NoSuchKey', undefined],
      ['NotFound', 404],
    ])('%s / %s is not found', async (name, status) => {
      send.mockRejectedValue(s3Error(name, status));
      await expect(storage.read(KEY)).rejects.toBeInstanceOf(
        ObjectNotFoundError,
      );
    });

    it.each([403, 500, 503])('status %i is unavailable', async (status) => {
      send.mockRejectedValue(s3Error('Whatever', status));
      await expect(storage.read(KEY)).rejects.toBeInstanceOf(
        StorageUnavailableError,
      );
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(KEY);
    });

    it('an invalid key is not found without a request', async () => {
      await expect(storage.read('../x')).rejects.toBeInstanceOf(
        ObjectNotFoundError,
      );
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('deletes the object', async () => {
      send.mockResolvedValue({});
      await expect(storage.delete(KEY)).resolves.toBe('deleted');
      expect((send.mock.calls[0] as [{ input: unknown }])[0].input).toEqual({
        Bucket: SECRET_BUCKET,
        Key: KEY,
      });
    });

    it.each([
      ['NoSuchKey', undefined],
      ['NotFound', 404],
    ])('%s / %s is not_found', async (name, status) => {
      send.mockRejectedValue(s3Error(name, status));
      await expect(storage.delete(KEY)).resolves.toBe('not_found');
    });

    it('any other failure is unavailable', async () => {
      send.mockRejectedValue(s3Error('InternalError', 500));
      await expect(storage.delete(KEY)).resolves.toBe('unavailable');
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(SECRET_BUCKET);
    });

    it('an invalid key is not_found without a request', async () => {
      await expect(storage.delete('../x')).resolves.toBe('not_found');
      expect(send).not.toHaveBeenCalled();
    });
  });
});
