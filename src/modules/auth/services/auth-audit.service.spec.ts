import { Logger } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';

import { AuthAuditService } from './auth-audit.service';

const build = (key = 'k'.repeat(40)) =>
  new AuthAuditService({ get: () => key } as unknown as ConfigService);

describe('AuthAuditService', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('pseudonym', () => {
    it('is stable for the same email and never contains it', () => {
      const audit = build();

      const first = audit.pseudonym('user@example.com');

      expect(audit.pseudonym('user@example.com')).toBe(first);
      expect(first).toMatch(/^[0-9a-f]{24}$/);
      expect(first).not.toContain('user');
    });

    it('differs per email and per key', () => {
      expect(build().pseudonym('a@example.com')).not.toBe(
        build().pseudonym('b@example.com'),
      );
      expect(build('a'.repeat(40)).pseudonym('a@example.com')).not.toBe(
        build('b'.repeat(40)).pseudonym('a@example.com'),
      );
    });
  });

  it.each(['info', 'warn', 'error'] as const)(
    'writes %s events as structured objects',
    (level) => {
      const method = { info: 'log', warn: 'warn', error: 'error' }[level];
      const spy = jest
        .spyOn(Logger.prototype, method as 'log')
        .mockImplementation(() => undefined);

      build()[level]('login.failed', { userId: 'u1', requestId: 'r1' });

      expect(spy).toHaveBeenCalledWith({
        event: 'login.failed',
        userId: 'u1',
        requestId: 'r1',
      });
    },
  );
});
