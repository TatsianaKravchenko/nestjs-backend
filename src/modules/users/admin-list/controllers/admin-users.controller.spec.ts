import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';

import type { RbacRequest } from '@/modules/rbac/rbac.types';
import { REQUIRED_PERMISSION_KEY } from '@/modules/rbac/rbac.constants';

import type { ListUsersQuery } from '../dto/list-users-query.dto';
import { AdminUsersRateGuard } from '../guards/admin-users-rate.guard';
import type { AdminUsersService } from '../services/admin-users.service';
import { AdminUsersController } from './admin-users.controller';

describe('AdminUsersController', () => {
  const list = jest.fn();
  const controller = new AdminUsersController({
    list,
  } as unknown as AdminUsersService);

  it('passes the request id, the actor and the validated query to the service', async () => {
    const page = { items: [], nextCursor: null };
    list.mockResolvedValue(page);
    const query: ListUsersQuery = {
      limit: 20,
      sort: 'createdAt',
      order: 'desc',
      paramNames: [],
    };

    await expect(
      controller.list(query, {
        id: 'req-1',
        user: { id: 'admin-1' },
      } as unknown as RbacRequest),
    ).resolves.toBe(page);
    expect(list).toHaveBeenCalledWith(
      { requestId: 'req-1', actorUserId: 'admin-1' },
      query,
    );
  });

  it('requires users@list at class level, before the method-level rate guard', () => {
    const reflector = new Reflector();
    expect(
      reflector.get(REQUIRED_PERMISSION_KEY, AdminUsersController),
    ).toEqual({ permission: 'users', action: 'list' });
    const handler = Object.getOwnPropertyDescriptor(
      AdminUsersController.prototype,
      'list',
    )?.value as object;
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([
      AdminUsersRateGuard,
    ]);
  });
});
