/* eslint-disable @typescript-eslint/unbound-method */
import {
  ExecutionContext,
  ForbiddenException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RECEIPT_HEADER_KEY } from '@/modules/auth/decorators/receipt.decorator';
import type { AuthAuditService } from '@/modules/auth/services/auth-audit.service';
import type { PolicySnapshotService } from '@/modules/rbac/policy-snapshot.service';
import { REQUIRED_PERMISSION_KEY } from '@/modules/rbac/rbac.constants';

import type { DeletionLimiter } from '../services/deletion-limiter.service';
import {
  DeletionAccessGuard,
  DeletionRoute,
  DeletionStatusRateGuard,
} from './deletion-access.guard';

class Fake {
  @DeletionRoute('self')
  self(): void {}

  @DeletionRoute('admin')
  admin(): void {}

  @DeletionRoute('status')
  status(): void {}
}

const ctx = (
  handler: () => void,
  request: {
    user?: { id: string };
    params?: { userId: string };
    headers?: Record<string, string>;
    ip?: string;
  },
) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ params: {}, headers: {}, ...request }),
    }),
    getClass: () => Fake,
    getHandler: () => handler,
  }) as unknown as ExecutionContext;

function setup(allowed = true) {
  const policy = { authorize: jest.fn().mockResolvedValue(allowed) };
  const audit = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
  const guard = new DeletionAccessGuard(
    new Reflector(),
    policy as unknown as PolicySnapshotService,
    audit as unknown as AuthAuditService,
  );
  return { guard, policy, audit };
}

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as HttpException).getResponse() as {
      code: string;
      statusCode: number;
    };
  }
  throw new Error('expected a rejection');
};

describe('DeletionRoute', () => {
  it('declares users@delete, and the receipt header only for the status scope', () => {
    const reflector = new Reflector();
    for (const name of ['self', 'admin', 'status'] as const) {
      expect(
        reflector.get(REQUIRED_PERMISSION_KEY, Fake.prototype[name]),
      ).toEqual({ permission: 'users', action: 'delete' });
    }
    expect(reflector.get(RECEIPT_HEADER_KEY, Fake.prototype.status)).toBe(
      'deletion-receipt',
    );
    expect(
      reflector.get(RECEIPT_HEADER_KEY, Fake.prototype.self),
    ).toBeUndefined();
  });
});

describe('DeletionAccessGuard', () => {
  it('self scope: lets the own id pass and refuses a foreign id (403)', async () => {
    const { guard } = setup();
    const own = ctx(Fake.prototype.self, {
      user: { id: 'a' },
      params: { userId: 'a' },
    });
    await expect(guard.canActivate(own)).resolves.toBe(true);

    const foreign = ctx(Fake.prototype.self, {
      user: { id: 'a' },
      params: { userId: 'b' },
    });
    await expect(guard.canActivate(foreign)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('answers 401 without a session', async () => {
    const { guard } = setup();
    await expect(
      guard.canActivate(ctx(Fake.prototype.self, { params: { userId: 'a' } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('admin scope: needs users@delete_any first (403), then refuses the own id', async () => {
    const denied = setup(false);
    const foreign = ctx(Fake.prototype.admin, {
      user: { id: 'a' },
      params: { userId: 'b' },
    });
    expect((await codeOf(denied.guard.canActivate(foreign))).code).toBe(
      'permission_denied',
    );
    expect(denied.policy.authorize).toHaveBeenCalledWith(
      'a',
      'users',
      'delete_any',
    );

    // Without delete_any the own id is a plain permission denial, not a hint.
    const own = ctx(Fake.prototype.admin, {
      user: { id: 'a' },
      params: { userId: 'a' },
    });
    expect((await codeOf(denied.guard.canActivate(own))).code).toBe(
      'permission_denied',
    );

    const allowed = setup(true);
    expect((await codeOf(allowed.guard.canActivate(own))).code).toBe(
      'self_confirmation_required',
    );
    await expect(allowed.guard.canActivate(foreign)).resolves.toBe(true);
    expect(allowed.audit.warn).toHaveBeenCalledWith(
      'users.deletion.access_denied',
      { result: 'self_confirmation_required', status: 403 },
    );
  });

  it('status scope: a receipt passes without a session or permission lookup', async () => {
    const { guard, policy } = setup();
    const request = ctx(Fake.prototype.status, {
      params: { userId: 'a' },
      headers: { 'deletion-receipt': 'x' },
    });
    await expect(guard.canActivate(request)).resolves.toBe(true);
    expect(policy.authorize).not.toHaveBeenCalled();
  });

  it('status scope without a receipt: 401 without a session, 403 without delete_any, ok with it', async () => {
    const { guard } = setup();
    await expect(
      guard.canActivate(
        ctx(Fake.prototype.status, { params: { userId: 'a' } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const denied = setup(false);
    const request = ctx(Fake.prototype.status, {
      user: { id: 'a' },
      params: { userId: 'b' },
    });
    await expect(denied.guard.canActivate(request)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(guard.canActivate(request)).resolves.toBe(true);

    // An empty receipt header does not count as a receipt.
    const empty = ctx(Fake.prototype.status, {
      params: { userId: 'a' },
      headers: { 'deletion-receipt': '' },
    });
    await expect(guard.canActivate(empty)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('logs the event and result only', async () => {
    const { guard, audit } = setup();
    await guard
      .canActivate(
        ctx(Fake.prototype.self, {
          user: { id: 'a' },
          params: { userId: 'b' },
        }),
      )
      .catch(() => undefined);
    expect(audit.warn).toHaveBeenCalledWith('users.deletion.access_denied', {
      result: 'foreign_target',
      status: 403,
    });
  });
});

describe('DeletionStatusRateGuard', () => {
  it('passes when the limiter has room and answers 429 with the wait otherwise', () => {
    const limiter = { hitStatus: jest.fn() };
    const audit = { warn: jest.fn() };
    const guard = new DeletionStatusRateGuard(
      limiter as unknown as DeletionLimiter,
      audit as unknown as AuthAuditService,
    );
    const request = ctx(Fake.prototype.status, { ip: '1.2.3.4' });

    limiter.hitStatus.mockReturnValue(0);
    expect(guard.canActivate(request)).toBe(true);
    expect(limiter.hitStatus).toHaveBeenCalledWith('1.2.3.4');

    limiter.hitStatus.mockReturnValue(12);
    try {
      guard.canActivate(request);
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(429);
      expect(
        (
          (error as HttpException).getResponse() as {
            retryAfterSeconds: number;
          }
        ).retryAfterSeconds,
      ).toBe(12);
    }
    expect(audit.warn).toHaveBeenCalledWith('users.deletion.rate_limited', {
      result: 'rate_limited',
      status: 429,
    });
  });
});
