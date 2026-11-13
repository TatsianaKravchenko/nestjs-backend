import { HealthIndicatorService } from '@nestjs/terminus';

import { ConfigService } from '@/core/config/config.service';

import { EmailChangeKeyHealthIndicator } from './email-change-key.health';

function setup(key: unknown) {
  const session = {
    up: jest.fn().mockReturnValue({ k: { status: 'up' } }),
    down: jest.fn().mockReturnValue({ k: { status: 'down' } }),
  };
  const check = jest.fn().mockReturnValue(session);
  const indicator = new EmailChangeKeyHealthIndicator(
    { check } as unknown as HealthIndicatorService,
    { get: () => key } as unknown as ConfigService,
  );
  return { indicator, session, check };
}

describe('EmailChangeKeyHealthIndicator', () => {
  it('is up for a key of 32 bytes', () => {
    const { indicator, session, check } = setup('k'.repeat(32));

    indicator.check();

    expect(check).toHaveBeenCalledWith('email_change_key');
    expect(session.up).toHaveBeenCalled();
    expect(session.down).not.toHaveBeenCalled();
  });

  it('counts bytes, not characters', () => {
    // 11 characters of 3 bytes = 33 bytes
    const { indicator, session } = setup('€'.repeat(11));

    indicator.check();

    expect(session.up).toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['31 bytes', 'k'.repeat(31)],
    ['not a string', 12345678],
  ])('is down when the key is %s, without leaking the key', (_label, key) => {
    const { indicator, session } = setup(key);

    indicator.check('custom');

    expect(session.down).toHaveBeenCalledWith({
      message: 'Email change HMAC key is missing or too short',
    });
    expect(JSON.stringify(session.down.mock.calls)).not.toContain('kkkk');
  });
});
