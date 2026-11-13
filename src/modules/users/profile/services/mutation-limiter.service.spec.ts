import { ConfigService } from '@/core/config/config.service';

import { MutationLimiter } from './mutation-limiter.service';

const HOUR = 3600_000;

function setup(env: Record<string, string> = {}) {
  const values: Record<string, string> = {
    PROFILE_MUTATION_WINDOW_MS: String(HOUR),
    PROFILE_MUTATION_LIMIT: '30',
    EMAIL_CHANGE_WINDOW_MS: String(HOUR),
    EMAIL_CHANGE_HOURLY_LIMIT: '5',
    ...env,
  };
  return new MutationLimiter({
    get: (key: string) => values[key],
  } as unknown as ConfigService);
}

describe('MutationLimiter', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  describe('mutations (30 per hour)', () => {
    it('allows 30 and denies the 31st with the seconds until the oldest expires', () => {
      const limiter = setup();
      for (let i = 0; i < 30; i++) {
        expect(limiter.hitMutation('a')).toEqual({
          allowed: true,
          retryAfterSeconds: 0,
        });
        jest.advanceTimersByTime(1000);
      }

      const denied = limiter.hitMutation('a');

      expect(denied.allowed).toBe(false);
      // the first hit was 30 s ago
      expect(denied.retryAfterSeconds).toBe(3570);
    });

    it('does not count a denied request', () => {
      const limiter = setup({ PROFILE_MUTATION_LIMIT: '1' });
      limiter.hitMutation('a');

      limiter.hitMutation('a');
      jest.advanceTimersByTime(HOUR + 1);

      expect(limiter.hitMutation('a').allowed).toBe(true);
    });

    it('counts users separately', () => {
      const limiter = setup({ PROFILE_MUTATION_LIMIT: '1' });

      expect(limiter.hitMutation('a').allowed).toBe(true);
      expect(limiter.hitMutation('b').allowed).toBe(true);
      expect(limiter.hitMutation('a').allowed).toBe(false);
    });

    it('allows again once the window has passed', () => {
      const limiter = setup({ PROFILE_MUTATION_LIMIT: '1' });
      limiter.hitMutation('a');
      jest.advanceTimersByTime(HOUR - 1);
      expect(limiter.hitMutation('a').allowed).toBe(false);

      jest.advanceTimersByTime(2);

      expect(limiter.hitMutation('a').allowed).toBe(true);
    });

    it('never reports less than 1 second', () => {
      const limiter = setup({ PROFILE_MUTATION_LIMIT: '1' });
      limiter.hitMutation('a');
      jest.advanceTimersByTime(HOUR - 1);

      expect(limiter.hitMutation('a').retryAfterSeconds).toBe(1);
    });

    it('keeps the email budget separate', () => {
      const limiter = setup({ PROFILE_MUTATION_LIMIT: '1' });
      limiter.hitMutation('a');

      expect(limiter.emailRetryAfter('a')).toBe(0);
    });
  });

  describe('emails (5 per hour)', () => {
    it('is open until five emails were recorded, then reports the wait', () => {
      const limiter = setup();
      for (let i = 0; i < 5; i++) {
        expect(limiter.emailRetryAfter('a')).toBe(0);
        limiter.recordEmail('a');
        jest.advanceTimersByTime(60_000);
      }

      expect(limiter.emailRetryAfter('a')).toBe(3600 - 300);
    });

    it('checking does not consume budget', () => {
      const limiter = setup({ EMAIL_CHANGE_HOURLY_LIMIT: '1' });

      limiter.emailRetryAfter('a');
      limiter.emailRetryAfter('a');

      expect(limiter.emailRetryAfter('a')).toBe(0);
    });

    it('opens again after the window and is per user', () => {
      const limiter = setup({ EMAIL_CHANGE_HOURLY_LIMIT: '1' });
      limiter.recordEmail('a');

      expect(limiter.emailRetryAfter('a')).toBeGreaterThan(0);
      expect(limiter.emailRetryAfter('b')).toBe(0);
      jest.advanceTimersByTime(HOUR + 1);
      expect(limiter.emailRetryAfter('a')).toBe(0);
    });
  });

  it('sweeps stale keys once there are very many', () => {
    const limiter = setup({ PROFILE_MUTATION_LIMIT: '1' });
    for (let i = 0; i < 10_001; i++) limiter.hitMutation(`u${i}`);
    jest.advanceTimersByTime(HOUR + 1);

    // This hit exceeds the sweep threshold again and must not throw.
    expect(limiter.hitMutation('late').allowed).toBe(true);
    expect(limiter.hitMutation('u0').allowed).toBe(true);
  });
});
