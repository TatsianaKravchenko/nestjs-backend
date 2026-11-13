/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { HttpException } from '@nestjs/common';

import { lockPolicyVersion } from '@/modules/rbac/policy-version';
import { hasActiveManageHolder } from '@/modules/rbac/rbac-invariant';

import { EmailChangeChallenge } from '../../entities/email-change-challenge.entity';
import { User, UserStatus } from '../../entities/user.entity';
import { UpdateUserDto } from '../dto/update-user.dto';
import { UserUpdateService } from './user-update.service';

jest.mock('@/modules/rbac/policy-version', () => ({
  lockPolicyVersion: jest.fn(),
}));
jest.mock('@/modules/rbac/rbac-invariant', () => ({
  hasActiveManageHolder: jest.fn(),
}));

const TARGET = '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44';
const ACTOR = '9d1f2c3e-1111-4222-8333-444455556666';
const OLD_EMAIL = 'old.secret@example.test';
const OLD_NAME = 'Old Secret Name';

const ctx = { requestId: 'req-1', actorUserId: ACTOR, targetUserId: TARGET };

const dto = (fields: Partial<UpdateUserDto>): UpdateUserDto =>
  Object.assign(new UpdateUserDto(), fields);

const failure = async (promise: Promise<unknown>): Promise<HttpException> => {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected a rejection');
};

describe('UserUpdateService', () => {
  let user: User;
  let order: string[];
  const builder = {
    update: jest.fn(),
    set: jest.fn(),
    where: jest.fn(),
    execute: jest.fn(),
  };
  const manager = {
    findOne: jest.fn(),
    findOneByOrFail: jest.fn(),
    existsBy: jest.fn(),
    update: jest.fn(),
    query: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const dataSource = { transaction: jest.fn() };
  const policy = { authorize: jest.fn() };
  const audit = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const config = { get: () => 'https://api.test' };
  const service = new UserUpdateService(
    dataSource as never,
    policy as never,
    audit as never,
    config as never,
  );

  const auditDump = () =>
    JSON.stringify([
      ...audit.info.mock.calls,
      ...audit.warn.mock.calls,
      ...audit.error.mock.calls,
    ]);

  beforeEach(() => {
    jest.resetAllMocks();
    order = [];
    user = Object.assign(new User(), {
      id: TARGET,
      email: OLD_EMAIL,
      displayName: OLD_NAME,
      photoKey: null,
      status: UserStatus.ACTIVE,
      passwordHash: 'hash',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    });
    dataSource.transaction.mockImplementation((work: (m: unknown) => unknown) =>
      work(manager),
    );
    policy.authorize.mockResolvedValue(true);
    (lockPolicyVersion as jest.Mock).mockImplementation(() => {
      order.push('lock-policy');
      return Promise.resolve(1);
    });
    manager.findOne.mockImplementation(() => {
      order.push('lock-user');
      return Promise.resolve(user);
    });
    manager.existsBy.mockResolvedValue(false);
    manager.update.mockResolvedValue(undefined);
    manager.query.mockResolvedValue([]);
    manager.findOneByOrFail.mockImplementation(() => Promise.resolve(user));
    builder.update.mockReturnValue(builder);
    builder.set.mockReturnValue(builder);
    builder.where.mockReturnValue(builder);
    builder.execute.mockResolvedValue(undefined);
    manager.createQueryBuilder.mockReturnValue(builder);
  });

  describe('permissions before the database', () => {
    it.each([
      ['email', { email: 'new@example.test' }],
      ['status', { status: UserStatus.BLOCKED }],
    ])('403 for %s without users@update_any, no DB call', async (_n, body) => {
      policy.authorize.mockResolvedValue(false);

      const error = await failure(
        service.update(ctx, dto(body as Partial<UpdateUserDto>)),
      );

      expect(error.getStatus()).toBe(403);
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(audit.warn).toHaveBeenCalledWith(
        'users.update.denied',
        expect.objectContaining({ fields: Object.keys(body)[0] }),
      );
    });

    it('does not ask for update_any when only displayName changes', async () => {
      await service.update(ctx, dto({ displayName: 'New' }));

      expect(policy.authorize).not.toHaveBeenCalled();
    });
  });

  describe('target checks', () => {
    it('404 for a missing user', async () => {
      manager.findOne.mockResolvedValue(null);

      const error = await failure(
        service.update(ctx, dto({ displayName: 'x' })),
      );

      expect(error.getStatus()).toBe(404);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('404 for a non-uuid id without querying', async () => {
      const error = await failure(
        service.update(
          { ...ctx, targetUserId: 'not-a-uuid' },
          dto({ displayName: 'x' }),
        ),
      );

      expect(error.getStatus()).toBe(404);
      expect(manager.findOne).not.toHaveBeenCalled();
    });

    it.each([UserStatus.PENDING, UserStatus.DELETING, UserStatus.DELETED])(
      '409 for a %s target',
      async (status) => {
        user.status = status;

        const error = await failure(
          service.update(ctx, dto({ displayName: 'x' })),
        );

        expect(error.getStatus()).toBe(409);
        expect(manager.update).not.toHaveBeenCalled();
      },
    );
  });

  describe('changes', () => {
    it('updates only the sent fields and returns the safe profile', async () => {
      manager.findOneByOrFail.mockResolvedValue(
        Object.assign(new User(), user, { displayName: 'New' }),
      );

      const profile = await service.update(ctx, dto({ displayName: 'New' }));

      expect(manager.update).toHaveBeenCalledWith(
        User,
        { id: TARGET },
        { displayName: 'New' },
      );
      expect(profile.displayName).toBe('New');
      expect(Object.keys(profile).sort()).toEqual(
        [
          'createdAt',
          'displayName',
          'email',
          'id',
          'photoUrl',
          'status',
          'updatedAt',
        ].sort(),
      );
      expect(audit.info).toHaveBeenCalledWith(
        'users.update',
        expect.objectContaining({ result: 'updated', fields: 'displayName' }),
      );
    });

    it('is a no-op when every value already matches (no update, no queries)', async () => {
      const profile = await service.update(
        ctx,
        dto({
          displayName: OLD_NAME,
          email: OLD_EMAIL.toUpperCase(),
          status: UserStatus.ACTIVE,
        }),
      );

      expect(manager.update).not.toHaveBeenCalled();
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
      expect(manager.query).not.toHaveBeenCalled();
      expect(profile.updatedAt).toBe('2026-01-02T00:00:00.000Z');
      expect(audit.info).toHaveBeenCalledWith(
        'users.update',
        expect.objectContaining({ result: 'unchanged' }),
      );
    });

    it('409 when the email is already used (pre-check)', async () => {
      manager.existsBy.mockResolvedValue(true);

      const error = await failure(
        service.update(ctx, dto({ email: 'taken@example.test' })),
      );

      expect(error.getStatus()).toBe(409);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('409 when the unique index rejects the UPDATE (race)', async () => {
      manager.update.mockRejectedValue({ driverError: { code: '23505' } });

      const error = await failure(
        service.update(ctx, dto({ email: 'race@example.test' })),
      );

      expect(error.getStatus()).toBe(409);
    });

    it('cancels the email challenge with admin_override on an email change', async () => {
      await service.update(ctx, dto({ email: 'direct@example.test' }));

      expect(manager.createQueryBuilder).toHaveBeenCalled();
      expect(builder.update).toHaveBeenCalledWith(EmailChangeChallenge);
      const set = builder.set.mock.calls[0][0] as Record<string, unknown>;
      expect(set.consumedReason).toBe('admin_override');
      expect(builder.where).toHaveBeenCalledWith(
        expect.stringContaining('consumed_at IS NULL'),
        { userId: TARGET },
      );
    });
  });

  describe('blocking', () => {
    beforeEach(() => {
      (hasActiveManageHolder as jest.Mock).mockImplementation(
        (_m: unknown, filter: { only?: string; exclude?: string }) =>
          Promise.resolve(Boolean(filter.only)),
      );
    });

    it('takes the policy lock before the user lock', async () => {
      (hasActiveManageHolder as jest.Mock).mockResolvedValue(false);

      await service.update(ctx, dto({ status: UserStatus.BLOCKED }));

      expect(order.slice(0, 2)).toEqual(['lock-policy', 'lock-user']);
    });

    it('does not take the policy lock for other changes or unblocking', async () => {
      user.status = UserStatus.BLOCKED;
      await service.update(ctx, dto({ status: UserStatus.ACTIVE }));
      await service.update(ctx, dto({ displayName: 'x' }));

      expect(lockPolicyVersion).not.toHaveBeenCalled();
    });

    it('409 last_access_manager when the target is a holder and nobody else is', async () => {
      (hasActiveManageHolder as jest.Mock).mockImplementation(
        (_m: unknown, filter: { only?: string }) =>
          Promise.resolve(Boolean(filter.only)),
      );

      const error = await failure(
        service.update(ctx, dto({ status: UserStatus.BLOCKED })),
      );

      expect(error.getStatus()).toBe(409);
      expect((error.getResponse() as { code: string }).code).toBe(
        'last_access_manager',
      );
      expect(manager.update).not.toHaveBeenCalled();
      expect(hasActiveManageHolder).toHaveBeenCalledWith(manager, {
        exclude: TARGET,
      });
    });

    it('allows blocking a holder when another active holder remains', async () => {
      (hasActiveManageHolder as jest.Mock).mockResolvedValue(true);

      await service.update(ctx, dto({ status: UserStatus.BLOCKED }));

      expect(manager.update).toHaveBeenCalledWith(
        User,
        { id: TARGET },
        { status: UserStatus.BLOCKED },
      );
    });

    it('allows blocking a non-holder even when there is no other holder', async () => {
      (hasActiveManageHolder as jest.Mock).mockResolvedValue(false);

      await service.update(ctx, dto({ status: UserStatus.BLOCKED }));

      expect(manager.update).toHaveBeenCalled();
    });

    it('consumes email-change and login challenges with user_inactive', async () => {
      (hasActiveManageHolder as jest.Mock).mockResolvedValue(false);

      await service.update(ctx, dto({ status: UserStatus.BLOCKED }));

      const set = builder.set.mock.calls[0][0] as Record<string, unknown>;
      expect(set.consumedReason).toBe('user_inactive');
      const loginUpdate = manager.query.mock.calls.find(([sql]) =>
        String(sql).includes('login_attempts'),
      );
      expect(loginUpdate?.[1]).toEqual([TARGET, 'user_inactive']);
    });

    it('logs the transition', async () => {
      (hasActiveManageHolder as jest.Mock).mockResolvedValue(false);

      await service.update(ctx, dto({ status: UserStatus.BLOCKED }));

      expect(audit.info).toHaveBeenCalledWith(
        'users.status_changed',
        expect.objectContaining({ transition: 'active->blocked' }),
      );
    });
  });

  describe('failures and logging', () => {
    it('503 when the database fails', async () => {
      dataSource.transaction.mockRejectedValue(new Error('connection lost'));

      const error = await failure(
        service.update(ctx, dto({ displayName: 'x' })),
      );

      expect(error.getStatus()).toBe(503);
      expect(audit.error).toHaveBeenCalledWith(
        'users.database_unavailable',
        expect.objectContaining({ requestId: 'req-1' }),
      );
    });

    it('logs field names, never values', async () => {
      const newEmail = 'brand.new@example.test';
      await service.update(
        ctx,
        dto({ displayName: 'Brand New Name', email: newEmail }),
      );
      manager.existsBy.mockResolvedValue(true);
      await failure(service.update(ctx, dto({ email: 'other@example.test' })));

      const logged = auditDump();
      expect(logged).toContain('displayName,email');
      for (const secret of [
        newEmail,
        'Brand New Name',
        OLD_EMAIL,
        OLD_NAME,
        'other@example.test',
        'hash',
      ]) {
        expect(logged).not.toContain(secret);
      }
    });
  });
});
