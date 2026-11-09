import { ExecutionContext, UnauthorizedException } from '@nestjs/common';

import { AccessTokenGuard } from './access-token.guard';
import { CookieService } from '../services/cookie.service';
import { SessionService } from '../services/session.service';

function build() {
  const request: { id: string; headers: object; user?: { id: string } } = {
    id: 'req-1',
    headers: { cookie: 'access_token=tok' },
  };
  const session = { authenticate: jest.fn().mockResolvedValue('user-1') };
  const cookies = { read: jest.fn().mockReturnValue('tok') };
  const guard = new AccessTokenGuard(
    session as unknown as SessionService,
    cookies as unknown as CookieService,
  );
  const context = {
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
});
