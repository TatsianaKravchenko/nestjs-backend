import { Logger } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';

import { AuthAuditService, redact } from './auth-audit.service';

describe('AuthAuditService redaction at the logger', () => {
  afterEach(() => jest.restoreAllMocks());
  const service = new AuthAuditService({
    get: () => 'k'.repeat(40),
  } as unknown as ConfigService);

  it.each([
    ['info', 'log'],
    ['warn', 'warn'],
    ['error', 'error'],
  ] as const)(
    '%s logs the event alone when no fields are given',
    (level, method) => {
      const spy = jest.spyOn(Logger.prototype, method).mockImplementation();

      service[level]('some.event');

      expect(spy).toHaveBeenCalledWith({ event: 'some.event' });
    },
  );

  it.each([
    ['info', 'log'],
    ['warn', 'warn'],
    ['error', 'error'],
  ] as const)(
    '%s never passes sensitive fields to the logger',
    (level, method) => {
      const spy = jest.spyOn(Logger.prototype, method).mockImplementation();

      service[level]('some.event', { requestId: 'r1', cookie: 'a=b' });

      expect(spy).toHaveBeenCalledWith({
        event: 'some.event',
        requestId: 'r1',
      });
    },
  );
});

describe('audit redaction', () => {
  it('keeps ids, categories and the single permission name', () => {
    const fields = {
      requestId: 'r1',
      actorUserId: 'u1',
      category: 'permission_denied',
      permission: 'users',
      action: 'read',
      policyVersion: 3,
    };
    expect(redact(fields)).toEqual(fields);
  });

  it('drops secrets, raw request data and full role/permission lists', () => {
    const result = redact({
      requestId: 'r1',
      accessToken: 'jwt',
      jwt: 'jwt',
      cookie: 'a=b',
      setCookie: 'a=b',
      authorization: 'Bearer x',
      password: 'p',
      passwordHash: 'h',
      secret: 's',
      signingKey: 'k',
      otp: '123456',
      requestBody: '{}',
      headers: '{}',
      roles: 'admin,user',
      permissions: 'a,b',
    });
    expect(result).toEqual({ requestId: 'r1' });
  });
});
