import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { UserStatus } from '@/modules/users/entities/user.entity';
import { UsersService } from '@/modules/users/users.service';

import { AuthAuditService } from './auth-audit.service';
import { SessionService } from './session.service';
import { InvalidTokenError, TokenService } from './token.service';

const USER_ID = '0b8b6f4e-6a53-4b0c-9a51-0d3d7a4c9f10';
const ctx = { ip: '1.1.1.1', requestId: 'req-1' };

function build() {
  const tokens = {
    verifyAccess: jest.fn().mockResolvedValue(USER_ID),
    verifyRefresh: jest.fn().mockResolvedValue(USER_ID),
    issuePair: jest.fn().mockResolvedValue({ access: 'a', refresh: 'r' }),
  };
  const users = {
    findAuthState: jest
      .fn()
      .mockResolvedValue({ id: USER_ID, status: UserStatus.ACTIVE }),
  };
  const audit = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new SessionService(
    tokens as unknown as TokenService,
    users as unknown as UsersService,
    audit as unknown as AuthAuditService,
  );
  return { service, tokens, users, audit };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe('SessionService.authenticate', () => {
  it('resolves with the user id of an active user', async () => {
    const { service, users } = build();

    await expect(service.authenticate('token')).resolves.toBe(USER_ID);
    expect(users.findAuthState).toHaveBeenCalledWith(USER_ID);
  });

  it.each([
    'missing',
    'malformed',
    'signature',
    'expired',
    'claims',
    'token_use',
  ] as const)(
    'answers invalid_session for a %s token and logs the category',
    async (reason) => {
      const { service, tokens, users, audit } = build();
      tokens.verifyAccess.mockRejectedValue(new InvalidTokenError(reason));

      const error = await failure(service.authenticate('token', ctx));

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).getResponse()).toEqual({
        statusCode: 401,
        code: 'invalid_session',
        message: 'Invalid session',
      });
      expect(users.findAuthState).not.toHaveBeenCalled();
      expect(audit.warn).toHaveBeenCalledWith('access.rejected', {
        category: reason,
        status: 401,
        reason,
        userId: undefined,
        requestId: 'req-1',
      });
    },
  );

  it.each([
    ['unknown user', null],
    ['pending user', { id: USER_ID, status: UserStatus.PENDING }],
    ['blocked user', { id: USER_ID, status: 'blocked' }],
    ['deleting user', { id: USER_ID, status: 'deleting' }],
    ['deleted user', { id: USER_ID, status: 'deleted' }],
  ])('answers the same invalid_session for a %s', async (_name, user) => {
    const { service, users, audit } = build();
    users.findAuthState.mockResolvedValue(user);

    const error = await failure(service.authenticate('token', ctx));

    expect((error as UnauthorizedException).getResponse()).toMatchObject({
      code: 'invalid_session',
    });
    expect(audit.warn).toHaveBeenCalledWith(
      'access.rejected',
      expect.objectContaining({ reason: 'user_inactive' }),
    );
  });

  it('rethrows an unexpected verification error instead of answering 401', async () => {
    const { service, tokens, users } = build();
    const unexpected = new Error('boom');
    tokens.verifyAccess.mockRejectedValue(unexpected);

    await expect(service.authenticate('token', ctx)).rejects.toBe(unexpected);
    expect(users.findAuthState).not.toHaveBeenCalled();
  });

  it('answers 503, not 401, when the database is unavailable', async () => {
    const { service, users } = build();
    users.findAuthState.mockRejectedValue(new Error('connection refused'));

    await expect(service.authenticate('token')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('SessionService.refresh', () => {
  it('issues a new pair for an active user without storing anything', async () => {
    const { service, tokens, audit } = build();

    await expect(service.refresh('refresh-token', ctx)).resolves.toEqual({
      access: 'a',
      refresh: 'r',
    });
    expect(tokens.verifyRefresh).toHaveBeenCalledWith('refresh-token');
    expect(tokens.issuePair).toHaveBeenCalledWith(USER_ID);
    expect(audit.info).toHaveBeenCalledWith('refresh.success', {
      userId: USER_ID,
      requestId: 'req-1',
    });
  });

  it('answers invalid_session and issues nothing without a valid token', async () => {
    const { service, tokens, audit } = build();
    tokens.verifyRefresh.mockRejectedValue(new InvalidTokenError('missing'));

    const error = await failure(service.refresh(undefined, ctx));

    expect((error as UnauthorizedException).getResponse()).toMatchObject({
      code: 'invalid_session',
    });
    expect(tokens.issuePair).not.toHaveBeenCalled();
    expect(audit.warn).toHaveBeenCalledWith(
      'refresh.failed',
      expect.objectContaining({ reason: 'missing' }),
    );
  });

  it('refuses a user who is no longer active', async () => {
    const { service, users, tokens } = build();
    users.findAuthState.mockResolvedValue({
      id: USER_ID,
      status: UserStatus.PENDING,
    });

    await expect(service.refresh('refresh-token', ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(tokens.issuePair).not.toHaveBeenCalled();
  });

  it('answers 503 when the database is unavailable', async () => {
    const { service, users } = build();
    users.findAuthState.mockRejectedValue(new Error('down'));

    await expect(service.refresh('refresh-token', ctx)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('answers 503 when signing fails', async () => {
    const { service, tokens } = build();
    tokens.issuePair.mockRejectedValue(new ServiceUnavailableException());

    await expect(service.refresh('refresh-token', ctx)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
