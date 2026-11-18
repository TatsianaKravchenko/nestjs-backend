import type { HealthIndicatorService } from '@nestjs/terminus';

import type { ConfigService } from '@/core/config/config.service';

import { UserListCursorHealthIndicator } from './user-list-cursor.health';

function indicator(env: Record<string, string | undefined>) {
  const session = {
    up: jest.fn(() => ({ k: { status: 'up' } })),
    down: jest.fn((data: object) => ({ k: { status: 'down', ...data } })),
  };
  const subject = new UserListCursorHealthIndicator(
    { check: () => session } as unknown as HealthIndicatorService,
    { get: (key: string) => env[key] } as unknown as ConfigService,
  );
  return { subject, session };
}

describe('UserListCursorHealthIndicator', () => {
  it('is up for a valid configuration', () => {
    const { subject, session } = indicator({
      USER_LIST_CURSOR_ACTIVE_KEY_ID: 'k1',
      USER_LIST_CURSOR_HMAC_KEYS: `k1:${'a'.repeat(32)}`,
    });
    subject.check();
    expect(session.up).toHaveBeenCalled();
  });

  it.each([
    [undefined, undefined],
    ['k1', `k1:${'a'.repeat(31)}`],
    ['k2', `k1:${'a'.repeat(32)}`],
  ])(
    'is down for active=%s keys=%s without leaking key material',
    (kid, keys) => {
      const { subject, session } = indicator({
        USER_LIST_CURSOR_ACTIVE_KEY_ID: kid,
        USER_LIST_CURSOR_HMAC_KEYS: keys,
      });
      subject.check();
      expect(session.down).toHaveBeenCalledTimes(1);
      const [data] = session.down.mock.calls[0] as unknown as [
        { message: string },
      ];
      expect(data.message).not.toContain('aaaa');
    },
  );
});
