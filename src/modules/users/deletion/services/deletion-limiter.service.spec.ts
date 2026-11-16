import type { ConfigService } from '@/core/config/config.service';

import { DeletionLimiter } from './deletion-limiter.service';

const make = (env: Record<string, string>) =>
  new DeletionLimiter({
    get: (key: string) => env[key],
  } as unknown as ConfigService);

describe('DeletionLimiter', () => {
  it('allows the configured emails per user and then reports the wait', () => {
    const limiter = make({
      DELETION_EMAIL_HOURLY_LIMIT: '2',
      DELETION_EMAIL_WINDOW_MS: '3600000',
    });
    expect(limiter.emailRetryAfter('u')).toBe(0);
    limiter.recordEmail('u');
    limiter.recordEmail('u');
    expect(limiter.emailRetryAfter('u')).toBeGreaterThan(0);
    expect(limiter.emailRetryAfter('v')).toBe(0);
  });

  it('counts status reads per IP and refuses over the limit', () => {
    const limiter = make({
      DELETION_STATUS_LIMIT: '2',
      DELETION_STATUS_WINDOW_MS: '60000',
    });
    expect(limiter.hitStatus('1.1.1.1')).toBe(0);
    expect(limiter.hitStatus('1.1.1.1')).toBe(0);
    expect(limiter.hitStatus('1.1.1.1')).toBeGreaterThan(0);
    expect(limiter.hitStatus('2.2.2.2')).toBe(0);
  });
});
