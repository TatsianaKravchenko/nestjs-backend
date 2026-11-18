import type { ConfigService } from '@/core/config/config.service';

import { AdminUsersLimiter } from './admin-users-limiter.service';

function limiter(actor = 2, ip = 3, windowMs = 60000) {
  const env: Record<string, number> = {
    ADMIN_USERS_LIST_WINDOW_MS: windowMs,
    ADMIN_USERS_LIST_ACTOR_LIMIT: actor,
    ADMIN_USERS_LIST_IP_LIMIT: ip,
  };
  return new AdminUsersLimiter({
    get: (key: string) => env[key],
  } as unknown as ConfigService);
}

describe('AdminUsersLimiter', () => {
  afterEach(() => jest.useRealTimers());

  it('refuses the actor beyond its limit with a retry delay', () => {
    const l = limiter(2, 100);
    expect(l.hit('a', '1.1.1.1')).toBe(0);
    expect(l.hit('a', '1.1.1.2')).toBe(0);
    expect(l.hit('a', '1.1.1.3')).toBeGreaterThan(0);
    expect(l.hit('b', '1.1.1.4')).toBe(0);
  });

  it('refuses an IP beyond its limit across actors', () => {
    const l = limiter(100, 3);
    expect(l.hit('a', '9.9.9.9')).toBe(0);
    expect(l.hit('b', '9.9.9.9')).toBe(0);
    expect(l.hit('c', '9.9.9.9')).toBe(0);
    expect(l.hit('d', '9.9.9.9')).toBeGreaterThan(0);
    expect(l.hit('d', '8.8.8.8')).toBe(0);
  });

  it('does not count a refused request', () => {
    jest.useFakeTimers();
    const l = limiter(1, 100, 1000);
    expect(l.hit('a', 'ip')).toBe(0);
    for (let i = 0; i < 5; i++) expect(l.hit('a', 'ip')).toBeGreaterThan(0);
    jest.advanceTimersByTime(1001);
    expect(l.hit('a', 'ip')).toBe(0);
  });
});
