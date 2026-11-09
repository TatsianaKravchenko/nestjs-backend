import { ConfigService } from '@/core/config/config.service';

import { LoginFailureLimiter } from './login-failure-limiter.service';

function build(limit = '5', windowMs = '900000') {
  const values: Record<string, string> = {
    LOGIN_FAILURE_LIMIT: limit,
    LOGIN_FAILURE_WINDOW_MS: windowMs,
  };
  const config = { get: (key: string) => values[key] };
  return new LoginFailureLimiter(config as unknown as ConfigService);
}

describe('LoginFailureLimiter', () => {
  afterEach(() => jest.useRealTimers());

  it('blocks a key after the configured number of failures', () => {
    const limiter = build();

    for (let i = 0; i < 4; i++) limiter.recordFailure('k');
    expect(limiter.isBlocked('k')).toBe(false);

    limiter.recordFailure('k');
    expect(limiter.isBlocked('k')).toBe(true);
  });

  it('tracks each key separately', () => {
    const limiter = build('1');

    limiter.recordFailure('email-a|1.1.1.1');

    expect(limiter.isBlocked('email-a|1.1.1.1')).toBe(true);
    expect(limiter.isBlocked('email-a|2.2.2.2')).toBe(false);
    expect(limiter.isBlocked('email-b|1.1.1.1')).toBe(false);
  });

  it('forgets failures once the window has passed', () => {
    jest.useFakeTimers();
    const limiter = build('2', '1000');
    limiter.recordFailure('k');
    limiter.recordFailure('k');
    expect(limiter.isBlocked('k')).toBe(true);

    jest.advanceTimersByTime(1001);

    expect(limiter.isBlocked('k')).toBe(false);
  });

  it('clears a key on reset', () => {
    const limiter = build('1');
    limiter.recordFailure('k');

    limiter.reset('k');

    expect(limiter.isBlocked('k')).toBe(false);
  });
});
