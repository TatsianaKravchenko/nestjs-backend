import {
  ExecutionContext,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';

import type { AuthAuditService } from '@/modules/auth/services/auth-audit.service';

import type { AdminUsersLimiter } from '../services/admin-users-limiter.service';
import { AdminUsersRateGuard } from './admin-users-rate.guard';

const context = (request: object) =>
  ({
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

describe('AdminUsersRateGuard', () => {
  const hit = jest.fn();
  const warn = jest.fn();
  const guard = new AdminUsersRateGuard(
    { hit } as unknown as AdminUsersLimiter,
    { warn } as unknown as AuthAuditService,
  );
  beforeEach(() => jest.resetAllMocks());

  it('passes when the limiter allows', () => {
    hit.mockReturnValue(0);
    expect(
      guard.canActivate(context({ id: 'r', ip: '1.2.3.4', user: { id: 'u' } })),
    ).toBe(true);
    expect(hit).toHaveBeenCalledWith('u', '1.2.3.4');
  });

  it('answers 429 with Retry-After seconds and logs ids only', () => {
    hit.mockReturnValue(7);
    try {
      guard.canActivate(context({ id: 'r', ip: '1.2.3.4', user: { id: 'u' } }));
      fail('expected 429');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
      expect((error as HttpException).getResponse()).toMatchObject({
        retryAfterSeconds: 7,
      });
    }
    expect(warn).toHaveBeenCalledWith('users.admin_list.rate_limited', {
      requestId: 'r',
      actorUserId: 'u',
      result: 'rate_limited',
      status: 429,
    });
  });

  it('refuses a request without an authenticated user', () => {
    expect(() => guard.canActivate(context({ id: 'r', ip: 'x' }))).toThrow(
      UnauthorizedException,
    );
    expect(hit).not.toHaveBeenCalled();
  });
});
