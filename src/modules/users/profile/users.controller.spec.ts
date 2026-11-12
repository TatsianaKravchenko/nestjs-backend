/* eslint-disable @typescript-eslint/unbound-method */
import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { StreamableFile } from '@nestjs/common';
import { Readable } from 'stream';

import { AccessTokenGuard } from '@/modules/auth/guards/access-token.guard';
import { CsrfGuard } from '@/modules/auth/guards/csrf.guard';
import { REQUIRED_PERMISSION_KEY } from '@/modules/rbac/rbac.constants';
import { RbacGuard } from '@/modules/rbac/rbac.guard';
import type { RbacRequest } from '@/modules/rbac/rbac.types';

import { ProfileAccessGuard } from './profile-access.guard';
import { UserIdFormatGuard } from './user-id-format.guard';
import { UserProfileService } from './user-profile.service';
import { UsersController } from './users.controller';

const request = {
  id: 'req-1',
  user: { id: 'actor' },
} as unknown as RbacRequest;

describe('UsersController', () => {
  const profiles = {
    getProfile: jest.fn(),
    getPhoto: jest.fn(),
  };
  const controller = new UsersController(
    profiles as unknown as UserProfileService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('delegates the profile read with the verified actor', async () => {
    profiles.getProfile.mockResolvedValue({ id: 't' });

    await expect(controller.getProfile('t', request)).resolves.toEqual({
      id: 't',
    });
    expect(profiles.getProfile).toHaveBeenCalledWith({
      requestId: 'req-1',
      actorUserId: 'actor',
      targetUserId: 't',
    });
  });

  it('streams the photo with hardened headers', async () => {
    const stream = Readable.from(['x']);
    profiles.getPhoto.mockResolvedValue(stream);
    const header = jest.fn();

    const file = await controller.getPhoto('t', request, {
      header,
    } as never);

    expect(file).toBeInstanceOf(StreamableFile);
    expect(file.getHeaders().type).toBe('image/webp');
    expect(header).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(header).toHaveBeenCalledWith(
      'Cache-Control',
      'private, max-age=300',
    );
  });

  describe('declared check order', () => {
    it('validates the id, then authenticates, then RBAC, then read_any/limit', () => {
      const classGuards = Reflect.getMetadata(
        GUARDS_METADATA,
        UsersController,
      ) as unknown[];
      expect(classGuards).toEqual([
        UserIdFormatGuard,
        AccessTokenGuard,
        CsrfGuard,
        RbacGuard,
      ]);

      for (const handler of [
        UsersController.prototype.getProfile,
        UsersController.prototype.getPhoto,
      ]) {
        expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([
          ProfileAccessGuard,
        ]);
      }
    });

    it('requires users@read on every route', () => {
      expect(
        Reflect.getMetadata(REQUIRED_PERMISSION_KEY, UsersController),
      ).toEqual({ permission: 'users', action: 'read' });
    });
  });
});
