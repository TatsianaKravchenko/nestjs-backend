/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { HttpException, UnsupportedMediaTypeException } from '@nestjs/common';

import {
  StorageCleanupJob,
  StorageCleanupReason,
  StorageCleanupStatus,
} from '../../entities/storage-cleanup-job.entity';
import { User, UserStatus } from '../../entities/user.entity';
import { newPhotoKey, UserPhotoService } from './user-photo.service';

const TARGET = '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44';
const ACTOR = '9d1f2c3e-1111-4222-8333-444455556666';
const OLD_KEY = 'previous-object-key.webp';
const ctx = { requestId: 'req-1', actorUserId: ACTOR, targetUserId: TARGET };
const file = {
  data: Buffer.from('original-upload-bytes'),
  mimetype: 'image/png',
};
const NORMALIZED = Buffer.from('normalized-webp-bytes');

const failure = async (promise: Promise<unknown>): Promise<HttpException> => {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected a rejection');
};

describe('UserPhotoService', () => {
  let user: User | null;
  const manager = {
    findOne: jest.fn(),
    findOneByOrFail: jest.fn(),
    update: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
  };
  const dataSource = { transaction: jest.fn() };
  const normalizer = { normalize: jest.fn() };
  const audit = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const config = { get: () => 'https://api.test' };
  const storage = {
    read: jest.fn(),
    write: jest.fn(),
    delete: jest.fn(),
    listOlderThan: jest.fn(),
  };
  const service = new UserPhotoService(
    dataSource as never,
    normalizer as never,
    audit as never,
    config as never,
    storage as never,
  );

  const auditDump = () =>
    JSON.stringify([
      ...audit.info.mock.calls,
      ...audit.warn.mock.calls,
      ...audit.error.mock.calls,
    ]);
  const writtenKey = () => storage.write.mock.calls[0][0] as string;

  beforeEach(() => {
    jest.resetAllMocks();
    user = Object.assign(new User(), {
      id: TARGET,
      email: 'owner@example.test',
      displayName: null,
      photoKey: null,
      status: UserStatus.ACTIVE,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    });
    dataSource.transaction.mockImplementation((work: (m: unknown) => unknown) =>
      work(manager),
    );
    normalizer.normalize.mockResolvedValue(NORMALIZED);
    storage.write.mockResolvedValue(undefined);
    storage.delete.mockResolvedValue('deleted');
    manager.findOne.mockImplementation(() => Promise.resolve(user));
    manager.update.mockResolvedValue(undefined);
    manager.create.mockImplementation((_e: unknown, fields: object) =>
      Object.assign(new StorageCleanupJob(), fields),
    );
    manager.save.mockImplementation((job: StorageCleanupJob) =>
      Promise.resolve(Object.assign(job, { id: 'job-1' })),
    );
    manager.findOneByOrFail.mockImplementation(() =>
      Promise.resolve(Object.assign(new User(), user)),
    );
  });

  describe('newPhotoKey', () => {
    it('is opaque: base64url of 192 random bits plus .webp, unique, without ids', () => {
      const keys = new Set(Array.from({ length: 200 }, () => newPhotoKey()));

      expect(keys.size).toBe(200);
      for (const key of keys) {
        expect(key).toMatch(/^[A-Za-z0-9_-]{32}\.webp$/);
        expect(key).not.toContain(TARGET);
      }
    });
  });

  describe('replace', () => {
    it('first upload: writes the normalized bytes, sets the key, queues nothing', async () => {
      const profile = await service.replace(ctx, file);

      expect(normalizer.normalize).toHaveBeenCalledWith(file.data, 'image/png');
      expect(storage.write).toHaveBeenCalledWith(writtenKey(), NORMALIZED);
      expect(manager.update).toHaveBeenCalledWith(
        User,
        { id: TARGET },
        { photoKey: writtenKey() },
      );
      expect(manager.save).not.toHaveBeenCalled();
      expect(profile.id).toBe(TARGET);
      expect(audit.info).toHaveBeenCalledWith(
        'users.photo.uploaded',
        expect.objectContaining({ result: 'created' }),
      );
    });

    it('replacement: queues a photo_replaced job for the old key', async () => {
      user!.photoKey = OLD_KEY;

      await service.replace(ctx, file);

      const job = manager.save.mock.calls[0][0] as StorageCleanupJob;
      expect(job.objectKey).toBe(OLD_KEY);
      expect(job.reason).toBe(StorageCleanupReason.PHOTO_REPLACED);
      expect(job.status).toBe(StorageCleanupStatus.QUEUED);
      expect(job.attempts).toBe(0);
      expect(job.nextAttemptAt).toBeInstanceOf(Date);
      expect(manager.update).toHaveBeenCalledWith(
        User,
        { id: TARGET },
        { photoKey: expect.not.stringContaining(OLD_KEY) },
      );
      expect(audit.info).toHaveBeenCalledWith(
        'users.photo.uploaded',
        expect.objectContaining({ result: 'replaced', cleanupJobId: 'job-1' }),
      );
    });

    it('lets normalizer errors through before any storage or database work', async () => {
      normalizer.normalize.mockRejectedValue(
        new UnsupportedMediaTypeException('nope'),
      );

      const error = await failure(service.replace(ctx, file));

      expect(error.getStatus()).toBe(415);
      expect(storage.write).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(audit.warn).toHaveBeenCalledWith(
        'users.photo.rejected',
        expect.objectContaining({ result: 'invalid_file', status: 415 }),
      );
    });

    it('503 and an untouched database when the storage write fails', async () => {
      storage.write.mockRejectedValue(new Error('disk full'));

      const error = await failure(service.replace(ctx, file));

      expect(error.getStatus()).toBe(503);
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
      expect(audit.error).toHaveBeenCalledWith(
        'users.storage_unavailable',
        expect.anything(),
      );
    });

    it('deletes the new object when the transaction fails (404 target)', async () => {
      user = null;

      const error = await failure(service.replace(ctx, file));

      expect(error.getStatus()).toBe(404);
      expect(storage.delete).toHaveBeenCalledWith(writtenKey());
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('deletes the new object and answers 503 when the database fails', async () => {
      dataSource.transaction.mockRejectedValue(new Error('connection lost'));

      const error = await failure(service.replace(ctx, file));

      expect(error.getStatus()).toBe(503);
      expect(storage.delete).toHaveBeenCalledWith(writtenKey());
    });

    it('still fails with the original error when deleting the new object fails', async () => {
      user = null;
      storage.delete.mockResolvedValue('unavailable');

      expect((await failure(service.replace(ctx, file))).getStatus()).toBe(404);
    });

    it.each([UserStatus.PENDING, UserStatus.DELETING, UserStatus.DELETED])(
      '409 for a %s target and the object is removed',
      async (status) => {
        user!.status = status;

        const error = await failure(service.replace(ctx, file));

        expect(error.getStatus()).toBe(409);
        expect(storage.delete).toHaveBeenCalledWith(writtenKey());
      },
    );

    it('accepts a blocked target', async () => {
      user!.status = UserStatus.BLOCKED;

      await service.replace(ctx, file);

      expect(manager.update).toHaveBeenCalled();
    });

    it('404 for a non-uuid target without a lookup', async () => {
      const error = await failure(
        service.replace({ ...ctx, targetUserId: 'not-a-uuid' }, file),
      );

      expect(error.getStatus()).toBe(404);
      expect(manager.findOne).not.toHaveBeenCalled();
    });

    it('never logs keys, bytes or the file', async () => {
      user!.photoKey = OLD_KEY;
      await service.replace(ctx, file);
      user = null;
      await failure(service.replace(ctx, file));

      const logged = auditDump();
      for (const secret of [
        OLD_KEY,
        writtenKey(),
        'original-upload-bytes',
        'normalized-webp-bytes',
        'image/png',
        'owner@example.test',
      ]) {
        expect(logged).not.toContain(secret);
      }
    });
  });

  describe('clear', () => {
    it('without a photo: no update, no job', async () => {
      await service.clear(ctx);

      expect(manager.update).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
      expect(audit.info).toHaveBeenCalledWith(
        'users.photo.cleared',
        expect.objectContaining({ result: 'unchanged' }),
      );
    });

    it('with a photo: clears the key and queues photo_cleared', async () => {
      user!.photoKey = OLD_KEY;

      await service.clear(ctx);

      expect(manager.update).toHaveBeenCalledWith(
        User,
        { id: TARGET },
        { photoKey: null },
      );
      const job = manager.save.mock.calls[0][0] as StorageCleanupJob;
      expect(job.objectKey).toBe(OLD_KEY);
      expect(job.reason).toBe(StorageCleanupReason.PHOTO_CLEARED);
      expect(auditDump()).not.toContain(OLD_KEY);
      expect(audit.info).toHaveBeenCalledWith(
        'users.photo.cleared',
        expect.objectContaining({ result: 'cleared', cleanupJobId: 'job-1' }),
      );
    });

    it('does not touch storage itself (the worker does)', async () => {
      user!.photoKey = OLD_KEY;

      await service.clear(ctx);

      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('404 for a missing target', async () => {
      user = null;

      expect((await failure(service.clear(ctx))).getStatus()).toBe(404);
    });

    it.each([UserStatus.PENDING, UserStatus.DELETING, UserStatus.DELETED])(
      '409 for a %s target',
      async (status) => {
        user!.status = status;

        expect((await failure(service.clear(ctx))).getStatus()).toBe(409);
        expect(manager.update).not.toHaveBeenCalled();
      },
    );

    it('503 when the database fails', async () => {
      dataSource.transaction.mockRejectedValue(new Error('down'));

      expect((await failure(service.clear(ctx))).getStatus()).toBe(503);
    });
  });
});
