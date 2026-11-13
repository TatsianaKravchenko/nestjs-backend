import { ConfigService } from '@/core/config/config.service';

import { ProfileRateLimiter } from './profile-rate-limiter.service';

const make = (over: Record<string, string> = {}) => {
  const env: Record<string, string> = {
    PROFILE_READ_WINDOW_MS: '60000',
    PROFILE_READ_OWN_LIMIT: '3',
    PROFILE_READ_FOREIGN_LIMIT: '2',
    ...over,
  };
  return new ProfileRateLimiter({
    get: (key: string) => env[key],
  } as unknown as ConfigService);
};

describe('ProfileRateLimiter', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('allows up to the own limit, then blocks with a retry hint', () => {
    const limiter = make();

    for (let i = 0; i < 3; i++) {
      expect(limiter.hit('a', 'self').allowed).toBe(true);
    }
    const blocked = limiter.hit('a', 'self');

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(60);
  });

  it('uses the lower limit for foreign reads', () => {
    const limiter = make();

    limiter.hit('a', 'foreign');
    limiter.hit('a', 'foreign');

    expect(limiter.hit('a', 'foreign').allowed).toBe(false);
  });

  it('counts self and foreign separately and per actor', () => {
    const limiter = make();
    limiter.hit('a', 'foreign');
    limiter.hit('a', 'foreign');

    expect(limiter.hit('a', 'self').allowed).toBe(true);
    expect(limiter.hit('b', 'foreign').allowed).toBe(true);
  });

  it('frees capacity once the window has passed', () => {
    const limiter = make();
    limiter.hit('a', 'foreign');
    limiter.hit('a', 'foreign');
    expect(limiter.hit('a', 'foreign').allowed).toBe(false);

    jest.advanceTimersByTime(60_001);

    expect(limiter.hit('a', 'foreign').allowed).toBe(true);
  });

  it('reports the time left until the oldest hit expires', () => {
    const limiter = make();
    limiter.hit('a', 'foreign');
    jest.advanceTimersByTime(20_000);
    limiter.hit('a', 'foreign');

    expect(limiter.hit('a', 'foreign').retryAfterSeconds).toBe(40);
  });

  it('sweeps expired keys when the map grows large', () => {
    const limiter = make();
    for (let i = 0; i < 10_001; i++) limiter.hit(`u${i}`, 'self');
    jest.advanceTimersByTime(60_001);

    limiter.hit('fresh', 'self');
    // 10_001 old keys are expired; a sweep is triggered only above the threshold.
    for (let i = 0; i < 10_001; i++) limiter.hit(`v${i}`, 'self');

    expect(limiter.hit('u0', 'self').allowed).toBe(true);
  });
});
