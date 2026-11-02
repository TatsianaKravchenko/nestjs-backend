import {
  ExecutionContext,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PolicySnapshotService } from './policy-snapshot.service';
import { RbacGuard } from './rbac.guard';
import type { RequiredPermission } from './rbac.types';

function build(options: {
  required?: RequiredPermission;
  user?: { id: string };
  authorize?: jest.Mock;
}) {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(options.required),
  };
  const policy = {
    authorize: options.authorize ?? jest.fn().mockResolvedValue(true),
  };
  const request = {
    id: 'req-1',
    method: 'GET',
    url: '/admin/rbac/roles?x=1',
    user: options.user,
  };
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  const guard = new RbacGuard(
    reflector as unknown as Reflector,
    policy as unknown as PolicySnapshotService,
  );
  return { guard, context, policy };
}

const manage: RequiredPermission = { permission: 'rbac', action: 'manage' };

describe('RbacGuard', () => {
  it('allows a user holding the permission', async () => {
    const { guard, context, policy } = build({
      required: manage,
      user: { id: 'u1' },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(policy.authorize).toHaveBeenCalledWith('u1', 'rbac', 'manage');
  });

  it('answers 401 without an authenticated user and does not run RBAC', async () => {
    const { guard, context, policy } = build({ required: manage });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(policy.authorize).not.toHaveBeenCalled();
  });

  it('answers 403 without leaking roles when the permission is missing', async () => {
    const { guard, context } = build({
      required: manage,
      user: { id: 'u1' },
      authorize: jest.fn().mockResolvedValue(false),
    });

    const error = await guard.canActivate(context).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(
      JSON.stringify((error as ForbiddenException).getResponse()),
    ).not.toMatch(/role|rbac|manage/i);
  });

  it('denies a route that has no declared permission', async () => {
    const { guard, context, policy } = build({ user: { id: 'u1' } });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(policy.authorize).not.toHaveBeenCalled();
  });

  it('propagates 503 when the policy is unavailable', async () => {
    const { guard, context } = build({
      required: manage,
      user: { id: 'u1' },
      authorize: jest
        .fn()
        .mockRejectedValue(new ServiceUnavailableException('down')),
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
