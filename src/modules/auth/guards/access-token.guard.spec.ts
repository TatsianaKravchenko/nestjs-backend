import {
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { RECEIPT_HEADER_KEY } from '../decorators/receipt.decorator';
import { AccessTokenGuard } from './access-token.guard';
import { CookieService } from '../services/cookie.service';
import { SessionService } from '../services/session.service';

class SampleController {
  handler(): void {}
}
const handler = (SampleController.prototype as { handler: () => void }).handler;

function build(
  options: {
    headers?: Record<string, string>;
    receipt?: string;
    isPublic?: boolean;
    permission?: { permission: string; action: string } | null;
  } = {},
) {
  Reflect.defineMetadata(
    'rbac:required-permission',
    options.permission === undefined
      ? { permission: 'users', action: 'read' }
      : (options.permission ?? undefined),
    handler,
  );
  Reflect.defineMetadata(IS_PUBLIC_KEY, options.isPublic, handler);
  Reflect.defineMetadata(RECEIPT_HEADER_KEY, options.receipt, handler);

  const request: { id: string; headers: object; user?: { id: string } } = {
    id: 'req-1',
    headers: { cookie: 'access_token=tok', ...options.headers },
  };
  const session = { authenticate: jest.fn().mockResolvedValue('user-1') };
  const cookies = { read: jest.fn().mockReturnValue('tok') };
  const guard = new AccessTokenGuard(
    session as unknown as SessionService,
    cookies as unknown as CookieService,
    new Reflector(),
  );
  const context = {
    getHandler: () => handler,
    getClass: () => SampleController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { guard, session, cookies, request, context };
}

describe('AccessTokenGuard', () => {
  it('sets request.user to the verified id only', async () => {
    const { guard, session, cookies, request, context } = build();

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(cookies.read).toHaveBeenCalledWith(request, 'access_token');
    expect(session.authenticate).toHaveBeenCalledWith('tok', {
      requestId: 'req-1',
    });
    expect(request.user).toEqual({ id: 'user-1' });
  });

  it('leaves request.user unset and rethrows when the session is invalid', async () => {
    const { guard, session, request, context } = build();
    session.authenticate.mockRejectedValue(new UnauthorizedException());

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(request.user).toBeUndefined();
  });

  it('fails closed with 503 for an undeclared route, before authenticating', async () => {
    const { guard, session, context } = build({ permission: null });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(session.authenticate).not.toHaveBeenCalled();
  });

  describe('receipt-guarded route', () => {
    it('skips authentication when the receipt header is present', async () => {
      const { guard, session, request, context } = build({
        receipt: 'deletion-receipt',
        headers: { 'deletion-receipt': 'abc' },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(session.authenticate).not.toHaveBeenCalled();
      expect(request.user).toBeUndefined();
    });

    it('authenticates normally when the header is absent', async () => {
      const { guard, session, request, context } = build({
        receipt: 'deletion-receipt',
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(session.authenticate).toHaveBeenCalled();
      expect(request.user).toEqual({ id: 'user-1' });
    });

    it('still rejects an invalid session when the header is absent', async () => {
      const { guard, session, context } = build({
        receipt: 'deletion-receipt',
      });
      session.authenticate.mockRejectedValue(new UnauthorizedException());

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });
});
