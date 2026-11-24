import 'reflect-metadata';

import { GUARDS_METADATA } from '@nestjs/common/constants';

import { AccessTokenGuard } from '@/modules/auth/guards/access-token.guard';
import { CsrfGuard } from '@/modules/auth/guards/csrf.guard';
import { REQUIRED_PERMISSION_KEY } from '@/modules/rbac/rbac.constants';
import { RbacGuard } from '@/modules/rbac/rbac.guard';

import type { HistoryQuery } from '../dto/history-query.dto';
import { HistoryRateGuard } from '../guards/history-rate.guard';
import { AdminTransformationHistoryController } from './admin-transformation-history.controller';
import { TransformationHistoryController } from './transformation-history.controller';

const QUERY: HistoryQuery = {
  limit: 20,
  filters: {
    type: null,
    sourceFormat: null,
    targetFormat: null,
    status: null,
    createdAtFrom: null,
    createdAtTo: null,
  },
};
const RESPONSE = { items: [], nextCursor: null };

describe('history controllers', () => {
  const history = { list: jest.fn().mockResolvedValue(RESPONSE) };

  beforeEach(() => history.list.mockClear());

  it('self route: the user is the authenticated actor, with no target', async () => {
    const controller = new TransformationHistoryController(history as never);
    await expect(
      controller.list(QUERY, { id: 'r1', user: { id: 'jwt-sub' } } as never),
    ).resolves.toBe(RESPONSE);
    expect(history.list).toHaveBeenCalledWith(
      { requestId: 'r1', actorUserId: 'jwt-sub' },
      QUERY,
    );
  });

  it('admin route: the target comes from the path, the actor from the session', async () => {
    const controller = new AdminTransformationHistoryController(
      history as never,
    );
    await controller.list('target-id', QUERY, {
      id: 'r2',
      user: { id: 'jwt-sub' },
    } as never);
    expect(history.list).toHaveBeenCalledWith(
      { requestId: 'r2', actorUserId: 'jwt-sub', targetUserId: 'target-id' },
      QUERY,
    );
  });

  it.each([
    [TransformationHistoryController, 'history'],
    [AdminTransformationHistoryController, 'history_any'],
  ])('%p requires transformations@%s', (controller, action) => {
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, controller)).toEqual({
      permission: 'transformations',
      action,
    });
  });

  it.each([
    TransformationHistoryController,
    AdminTransformationHistoryController,
  ])(
    '%p checks the session, CSRF and RBAC before the rate limit',
    (controller) => {
      expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toEqual([
        AccessTokenGuard,
        CsrfGuard,
        RbacGuard,
      ]);
      expect(
        Reflect.getMetadata(
          GUARDS_METADATA,
          controller.prototype.list as unknown as () => void,
        ),
      ).toEqual([HistoryRateGuard]);
    },
  );
});
