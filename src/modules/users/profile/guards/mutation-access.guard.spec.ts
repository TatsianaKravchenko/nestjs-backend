/* eslint-disable @typescript-eslint/unbound-method */
import {
  ExecutionContext,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';
import { PolicySnapshotService } from '@/modules/rbac/policy-snapshot.service';

import { MutationAccessGuard, SelfOnly } from './mutation-access.guard';
import { MutationLimiter } from '../services/mutation-limiter.service';

class FakeController {
  patch(): void {}

  @SelfOnly()
  emailChange(): void {}
}

const ctx = (
  user: { id: string } | undefined,
  userId: string,
  handler: () => void = FakeController.prototype.patch,
) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ id: 'req-1', user, params: { userId } }),
    }),
    getClass: () => FakeController,
    getHandler: () => handler,
  }) as unknown as ExecutionContext;

function setup() {
  const policy = { authorize: jest.fn().mockResolvedValue(true) };
  const limiter = {
    hitMutation: jest
      .fn()
      .mockReturnValue({ allowed: true, retryAfterSeconds: 0 }),
  };
  const audit = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
  const guard = new MutationAccessGuard(
    new Reflector(),
    policy as unknown as PolicySnapshotService,
    limiter as unknown as MutationLimiter,
    audit as unknown as AuthAuditService,
  );
  return { guard, policy, limiter, audit };
}

const emailChange = FakeController.prototype.emailChange;

describe('MutationAccessGuard', () => {
  it('answers 401 without a session', async () => {
    const { guard, policy } = setup();

    await expect(guard.canActivate(ctx(undefined, 'a'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(policy.authorize).not.toHaveBeenCalled();
  });

  it('does not check users@update_any for the own user and counts a mutation', async () => {
    const { guard, policy, limiter } = setup();

    await expect(guard.canActivate(ctx({ id: 'a' }, 'a'))).resolves.toBe(true);

    expect(policy.authorize).not.toHaveBeenCalled();
    expect(limiter.hitMutation).toHaveBeenCalledWith('a');
  });

  it('requires users@update_any for a foreign id', async () => {
    const { guard, policy, limiter } = setup();

    await expect(guard.canActivate(ctx({ id: 'a' }, 'b'))).resolves.toBe(true);

    expect(policy.authorize).toHaveBeenCalledWith('a', 'users', 'update_any');
    expect(limiter.hitMutation).toHaveBeenCalledWith('a');
  });

  it('answers 403 without users@update_any, before any rate limit, and logs the denial without the target', async () => {
    const { guard, policy, limiter, audit } = setup();
    policy.authorize.mockResolvedValue(false);

    await expect(
      guard.canActivate(ctx({ id: 'a' }, 'b')),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(limiter.hitMutation).not.toHaveBeenCalled();
    expect(audit.warn).toHaveBeenCalledWith(
      'users.access_denied',
      expect.objectContaining({
        actorUserId: 'a',
        permission: 'users',
        action: 'update_any',
        scope: 'foreign',
        status: 403,
      }),
    );
    const logged = JSON.stringify(audit.warn.mock.calls);
    expect(logged).not.toContain('"b"');
    expect(logged).not.toContain('@');
  });

  it('fails closed with 503 when the policy is unavailable', async () => {
    const { guard, policy } = setup();
    policy.authorize.mockRejectedValue(new ServiceUnavailableException());

    await expect(
      guard.canActivate(ctx({ id: 'a' }, 'b')),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('answers 429 with the retry time when the mutation limit is reached', async () => {
    const { guard, limiter, audit } = setup();
    limiter.hitMutation.mockReturnValue({
      allowed: false,
      retryAfterSeconds: 42,
    });

    const error = await guard
      .canActivate(ctx({ id: 'a' }, 'a'))
      .catch((e: HttpException) => e);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    expect((error as HttpException).getResponse()).toMatchObject({
      retryAfterSeconds: 42,
    });
    expect(audit.warn).toHaveBeenCalledWith(
      'users.rate_limited',
      expect.objectContaining({ actorUserId: 'a', status: 429 }),
    );
  });

  describe('self-only routes (email change)', () => {
    it('lets the own user through without counting a mutation', async () => {
      const { guard, limiter, policy } = setup();

      await expect(
        guard.canActivate(ctx({ id: 'a' }, 'a', emailChange)),
      ).resolves.toBe(true);

      expect(limiter.hitMutation).not.toHaveBeenCalled();
      expect(policy.authorize).not.toHaveBeenCalled();
    });

    it('refuses a foreign id with 403 even for a user with users@update_any', async () => {
      const { guard, policy, audit } = setup();
      policy.authorize.mockResolvedValue(true);

      await expect(
        guard.canActivate(ctx({ id: 'a' }, 'b', emailChange)),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(policy.authorize).not.toHaveBeenCalled();
      expect(audit.warn).toHaveBeenCalledWith(
        'users.access_denied',
        expect.objectContaining({ action: 'self_only' }),
      );
    });
  });
});
