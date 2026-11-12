/* eslint-disable @typescript-eslint/unbound-method */
import {
  ExecutionContext,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';
import { PolicySnapshotService } from '@/modules/rbac/policy-snapshot.service';

import { ProfileAccessGuard } from './profile-access.guard';
import { ProfileRateLimiter } from './profile-rate-limiter.service';

class FakeController {
  getProfile(): void {}
}

const ctx = (user: { id: string } | undefined, userId: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ id: 'req-1', user, params: { userId } }),
    }),
    getClass: () => FakeController,
    getHandler: () => FakeController.prototype.getProfile,
  }) as unknown as ExecutionContext;

function setup() {
  const policy = { authorize: jest.fn().mockResolvedValue(true) };
  const limiter = {
    hit: jest.fn().mockReturnValue({ allowed: true, retryAfterSeconds: 0 }),
  };
  const audit = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
  const guard = new ProfileAccessGuard(
    policy as unknown as PolicySnapshotService,
    limiter as unknown as ProfileRateLimiter,
    audit as unknown as AuthAuditService,
  );
  return { guard, policy, limiter, audit };
}

describe('ProfileAccessGuard', () => {
  it('does not check users@read_any for the own profile', async () => {
    const { guard, policy, limiter } = setup();

    await expect(guard.canActivate(ctx({ id: 'a' }, 'a'))).resolves.toBe(true);

    expect(policy.authorize).not.toHaveBeenCalled();
    expect(limiter.hit).toHaveBeenCalledWith('a', 'self');
  });

  it('requires users@read_any for a foreign id and rate limits it as foreign', async () => {
    const { guard, policy, limiter } = setup();

    await expect(guard.canActivate(ctx({ id: 'a' }, 'b'))).resolves.toBe(true);

    expect(policy.authorize).toHaveBeenCalledWith('a', 'users', 'read_any');
    expect(limiter.hit).toHaveBeenCalledWith('a', 'foreign');
  });

  it('answers 403 without read_any, before the limiter, and logs no target id', async () => {
    const { guard, policy, limiter, audit } = setup();
    policy.authorize.mockResolvedValue(false);

    await expect(guard.canActivate(ctx({ id: 'a' }, 'victim'))).rejects.toThrow(
      ForbiddenException,
    );

    expect(limiter.hit).not.toHaveBeenCalled();
    expect(audit.warn).toHaveBeenCalledWith(
      'users.access_denied',
      expect.objectContaining({
        actorUserId: 'a',
        permission: 'users',
        action: 'read_any',
        status: 403,
      }),
    );
    expect(JSON.stringify(audit.warn.mock.calls)).not.toContain('victim');
  });

  it('answers 429 with a retry hint and logs the trigger', async () => {
    const { guard, limiter, audit } = setup();
    limiter.hit.mockReturnValue({ allowed: false, retryAfterSeconds: 17 });

    const error = await guard
      .canActivate(ctx({ id: 'a' }, 'a'))
      .catch((e: HttpException) => e);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    expect((error as HttpException).getResponse()).toMatchObject({
      code: 'rate_limit_exceeded',
      retryAfterSeconds: 17,
    });
    expect(audit.warn).toHaveBeenCalledWith(
      'users.rate_limited',
      expect.objectContaining({ scope: 'self', status: 429 }),
    );
  });

  it('propagates 503 when the policy snapshot is unavailable', async () => {
    const { guard, policy, limiter } = setup();
    policy.authorize.mockRejectedValue(new ServiceUnavailableException());

    await expect(guard.canActivate(ctx({ id: 'a' }, 'b'))).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(limiter.hit).not.toHaveBeenCalled();
  });

  it('answers 401 when no user was authenticated', async () => {
    const { guard } = setup();

    await expect(guard.canActivate(ctx(undefined, 'a'))).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
