/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment */
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Readable } from 'stream';

import { ConfigService } from '@/core/config/config.service';
import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';

import { UserStatus } from '../entities/user.entity';
import type { PhotoStorage } from '../storage/photo-storage';
import { UsersService } from '../users.service';
import { UserProfileService } from './user-profile.service';

const ACTOR = 'actor-1';
const TARGET = 'target-1';
const base = { requestId: 'req-1', actorUserId: ACTOR };

const profileRow = (over: Record<string, unknown> = {}) => ({
  id: TARGET,
  email: 'jane@example.com',
  displayName: 'Jane Doe',
  photoKey: 'photos/internal-key.webp',
  status: UserStatus.ACTIVE,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  ...over,
});

function setup(env: Record<string, string> = {}) {
  const users = {
    findProfile: jest.fn().mockResolvedValue(profileRow()),
    findPhotoRef: jest.fn().mockResolvedValue({
      id: TARGET,
      status: UserStatus.ACTIVE,
      photoKey: 'photos/internal-key.webp',
    }),
  };
  const audit = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const config = {
    get: (key: string) =>
      ({ API_PUBLIC_URL: 'https://api.test', PORT: '3000', ...env })[key],
  };
  const storage: jest.Mocked<PhotoStorage> = {
    read: jest.fn().mockResolvedValue({
      status: 'found',
      stream: Readable.from(['bytes']),
    }),
  };
  const service = new UserProfileService(
    users as unknown as UsersService,
    audit as unknown as AuthAuditService,
    config as unknown as ConfigService,
    storage,
  );
  return { service, users, audit, storage };
}

const allLogged = (audit: ReturnType<typeof setup>['audit']) =>
  JSON.stringify([
    audit.info.mock.calls,
    audit.warn.mock.calls,
    audit.error.mock.calls,
  ]);

describe('UserProfileService.getProfile', () => {
  it('returns the safe projection', async () => {
    const { service } = setup();

    const profile = await service.getProfile({ ...base, targetUserId: TARGET });

    expect(profile).toMatchObject({
      id: TARGET,
      email: 'jane@example.com',
      displayName: 'Jane Doe',
      photoUrl: `https://api.test/users/${TARGET}/photo`,
      status: 'active',
    });
    expect(JSON.stringify(profile)).not.toContain('internal-key');
  });

  it('falls back to localhost when no public url is configured', async () => {
    const { service } = setup({ API_PUBLIC_URL: '' });

    const profile = await service.getProfile({ ...base, targetUserId: TARGET });

    expect(profile.photoUrl).toBe(
      `http://localhost:3000/users/${TARGET}/photo`,
    );
  });

  it('logs a successful foreign read without any profile data', async () => {
    const { service, audit } = setup();

    await service.getProfile({ ...base, targetUserId: TARGET });

    expect(audit.info).toHaveBeenCalledWith(
      'users.read',
      expect.objectContaining({
        requestId: 'req-1',
        actorUserId: ACTOR,
        operation: 'profile.read',
        scope: 'foreign',
        targetUserId: TARGET,
        result: 'success',
        durationMs: expect.any(Number),
      }),
    );
    const logged = allLogged(audit);
    for (const secret of [
      'jane@example.com',
      'Jane Doe',
      'internal-key',
      'https://api.test',
    ]) {
      expect(logged).not.toContain(secret);
    }
  });

  it('does not log a successful read of the own profile', async () => {
    const { service, audit } = setup();

    await service.getProfile({
      requestId: 'r',
      actorUserId: TARGET,
      targetUserId: TARGET,
    });

    expect(audit.info).not.toHaveBeenCalled();
  });

  it('answers 404 and logs it when the target does not exist', async () => {
    const { service, users, audit } = setup();
    users.findProfile.mockResolvedValue(null);

    await expect(
      service.getProfile({ ...base, targetUserId: TARGET }),
    ).rejects.toThrow(NotFoundException);

    expect(audit.warn).toHaveBeenCalledWith(
      'users.not_found',
      expect.objectContaining({ targetUserId: TARGET, status: 404 }),
    );
  });

  it.each([
    UserStatus.PENDING,
    UserStatus.ACTIVE,
    UserStatus.BLOCKED,
    UserStatus.DELETING,
    UserStatus.DELETED,
  ])('returns a %s target to an authorized caller', async (status) => {
    const { service, users } = setup();
    users.findProfile.mockResolvedValue(profileRow({ status }));

    const profile = await service.getProfile({ ...base, targetUserId: TARGET });

    expect(profile.status).toBe(status);
  });

  it('answers 503 and logs when the database fails', async () => {
    const { service, users, audit } = setup();
    users.findProfile.mockRejectedValue(new Error('connection refused'));

    await expect(
      service.getProfile({ ...base, targetUserId: TARGET }),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(audit.error).toHaveBeenCalledWith(
      'users.database_unavailable',
      expect.objectContaining({ status: 503 }),
    );
    expect(allLogged(audit)).not.toContain('connection refused');
  });
});

describe('UserProfileService.getPhoto', () => {
  it('streams the object for an allowed read', async () => {
    const { service, storage } = setup();

    const stream = await service.getPhoto({ ...base, targetUserId: TARGET });

    expect(storage.read).toHaveBeenCalledWith('photos/internal-key.webp');
    expect(stream).toBeInstanceOf(Readable);
  });

  it('logs a successful foreign photo read without the key', async () => {
    const { service, audit } = setup();

    await service.getPhoto({ ...base, targetUserId: TARGET });

    expect(audit.info).toHaveBeenCalledWith(
      'users.read',
      expect.objectContaining({ operation: 'photo.read', scope: 'foreign' }),
    );
    expect(allLogged(audit)).not.toContain('internal-key');
  });

  it.each([
    ['unknown user', null],
    ['no photo', { id: TARGET, status: UserStatus.ACTIVE, photoKey: null }],
    [
      'deleting user',
      { id: TARGET, status: UserStatus.DELETING, photoKey: 'k' },
    ],
    ['deleted user', { id: TARGET, status: UserStatus.DELETED, photoKey: 'k' }],
  ])('answers 404 without touching storage: %s', async (_name, row) => {
    const { service, users, storage } = setup();
    users.findPhotoRef.mockResolvedValue(row);

    await expect(
      service.getPhoto({ ...base, targetUserId: TARGET }),
    ).rejects.toThrow(NotFoundException);

    expect(storage.read).not.toHaveBeenCalled();
  });

  it('answers 503 and logs when storage is unavailable', async () => {
    const { service, storage, audit } = setup();
    storage.read.mockResolvedValue({ status: 'unavailable' });

    await expect(
      service.getPhoto({ ...base, targetUserId: TARGET }),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(audit.error).toHaveBeenCalledWith(
      'users.storage_unavailable',
      expect.anything(),
    );
  });

  it('answers 503 and reports a mismatch when the object is missing', async () => {
    const { service, storage, audit } = setup();
    storage.read.mockResolvedValue({ status: 'not_found' });

    await expect(
      service.getPhoto({ ...base, targetUserId: TARGET }),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(audit.error).toHaveBeenCalledWith(
      'users.photo_object_missing',
      expect.objectContaining({ targetUserId: TARGET }),
    );
    expect(allLogged(audit)).not.toContain('internal-key');
  });

  it('answers 503 when the database fails', async () => {
    const { service, users, storage } = setup();
    users.findPhotoRef.mockRejectedValue(new Error('down'));

    await expect(
      service.getPhoto({ ...base, targetUserId: TARGET }),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(storage.read).not.toHaveBeenCalled();
  });
});
