import {
  ExecutionContext,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY } from '@/modules/auth/decorators/public.decorator';
import { RECEIPT_HEADER_KEY } from '@/modules/auth/decorators/receipt.decorator';
import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';

import { PolicySnapshotService } from './policy-snapshot.service';
import { REQUIRED_PERMISSION_KEY } from './rbac.constants';
import { RbacGuard } from './rbac.guard';
import type { RequiredPermission } from './rbac.types';

class SampleController {
  handler(): void {}
}
const handler = (SampleController.prototype as { handler: () => void }).handler;

function build(options: {
  required?: RequiredPermission;
  isPublic?: boolean;
  receipt?: string;
  headers?: Record<string, string>;
  user?: { id: string };
  authorize?: jest.Mock;
}) {
  Reflect.defineMetadata(REQUIRED_PERMISSION_KEY, options.required, handler);
  Reflect.defineMetadata(IS_PUBLIC_KEY, options.isPublic, handler);
  Reflect.defineMetadata(RECEIPT_HEADER_KEY, options.receipt, handler);

  const policy = {
    authorize: options.authorize ?? jest.fn().mockResolvedValue(true),
    version: 7,
  };
  const audit = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const request = {
    id: 'req-1',
    method: 'GET',
    url: '/admin/rbac/roles?x=1',
    headers: options.headers ?? {},
    user: options.user,
  };
  const context = {
    getHandler: () => handler,
    getClass: () => SampleController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  const guard = new RbacGuard(
    new Reflector(),
    policy as unknown as PolicySnapshotService,
    audit as unknown as AuthAuditService,
  );
  return { guard, context, policy, audit };
}

const manage: RequiredPermission = { permission: 'rbac', action: 'manage' };

describe('RbacGuard', () => {
  it('allows a user holding the permission and logs the decision', async () => {
    const { guard, context, policy, audit } = build({
      required: manage,
      user: { id: 'u1' },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(policy.authorize).toHaveBeenCalledWith('u1', 'rbac', 'manage');
    expect(audit.info).toHaveBeenCalledWith('rbac.access_granted', {
      requestId: 'req-1',
      actorUserId: 'u1',
      operation: 'SampleController.handler',
      permission: 'rbac',
      action: 'manage',
      policyVersion: 7,
      result: 'allowed',
    });
  });

  it('omits the policy version from the log when none is loaded', async () => {
    const { guard, context, policy, audit } = build({
      required: manage,
      user: { id: 'u1' },
    });
    (policy as { version: number | null }).version = null;

    await guard.canActivate(context);

    expect(audit.info).toHaveBeenCalledWith(
      'rbac.access_granted',
      expect.objectContaining({ policyVersion: undefined }),
    );
  });

  it('answers 401 without an authenticated user and does not run RBAC', async () => {
    const { guard, context, policy } = build({ required: manage });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(policy.authorize).not.toHaveBeenCalled();
  });

  it('answers 403 without leaking roles and logs the denial', async () => {
    const { guard, context, audit } = build({
      required: manage,
      user: { id: 'u1' },
      authorize: jest.fn().mockResolvedValue(false),
    });

    const error = await guard.canActivate(context).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: 'permission_denied',
    });
    expect(
      JSON.stringify((error as ForbiddenException).getResponse()),
    ).not.toMatch(/role|rbac|manage/i);
    expect(audit.warn).toHaveBeenCalledWith(
      'rbac.access_denied',
      expect.objectContaining({
        category: 'permission_denied',
        actorUserId: 'u1',
        permission: 'rbac',
        action: 'manage',
        policyVersion: 7,
        result: 'denied',
        status: 403,
      }),
    );
  });

  it('never logs a target id, roles or request data', async () => {
    const { guard, context, audit } = build({
      required: manage,
      user: { id: 'u1' },
      headers: { cookie: 'access_token=secret.jwt.value' },
    });
    await guard.canActivate(context);

    const logged = JSON.stringify(audit.info.mock.calls);
    expect(logged).not.toMatch(/secret|cookie|roles|targetId/i);
  });

  it('fails closed with 503 for a route that has no declaration', async () => {
    const { guard, context, policy } = build({ user: { id: 'u1' } });

    const error = await guard.canActivate(context).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      code: 'authorization_unavailable',
    });
    expect(policy.authorize).not.toHaveBeenCalled();
  });

  it('fails closed with 503 for a public route that also declares a permission', async () => {
    const { guard, context, policy } = build({
      required: manage,
      isPublic: true,
      user: { id: 'u1' },
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
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

  describe('receipt-guarded route', () => {
    const receipt = {
      required: { permission: 'users', action: 'delete' },
      receipt: 'deletion-receipt',
    };

    it('skips RBAC when the receipt header is present', async () => {
      const { guard, context, policy } = build({
        ...receipt,
        headers: { 'deletion-receipt': 'abc' },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(policy.authorize).not.toHaveBeenCalled();
    });

    it('enforces the permission when the header is absent', async () => {
      const { guard, context, policy } = build({
        ...receipt,
        user: { id: 'u1' },
        authorize: jest.fn().mockResolvedValue(false),
      });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(policy.authorize).toHaveBeenCalledWith('u1', 'users', 'delete');
    });

    it('enforces the permission when the header is empty', async () => {
      const { guard, context, policy } = build({
        ...receipt,
        headers: { 'deletion-receipt': '' },
        user: { id: 'u1' },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(policy.authorize).toHaveBeenCalled();
    });
  });
});
