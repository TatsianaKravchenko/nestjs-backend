import { HistoryLimiter } from './history-limiter.service';

const make = (limit = 2, windowMs = 60000) =>
  new HistoryLimiter({
    get: (key: string) =>
      (
        ({
          TRANSFORM_HISTORY_RATE_LIMIT: limit,
          TRANSFORM_HISTORY_RATE_WINDOW_MS: windowMs,
        }) as Record<string, number>
      )[key],
  } as never);

describe('HistoryLimiter', () => {
  afterEach(() => jest.useRealTimers());

  it('allows the limit, then returns the seconds to wait', () => {
    const limiter = make(2);
    expect(limiter.hit('a')).toBe(0);
    expect(limiter.hit('a')).toBe(0);
    expect(limiter.hit('a')).toBeGreaterThan(0);
  });

  it('counts per user', () => {
    const limiter = make(1);
    expect(limiter.hit('a')).toBe(0);
    expect(limiter.hit('b')).toBe(0);
    expect(limiter.hit('a')).toBeGreaterThan(0);
  });

  it('a refused call is not counted, and the window slides', () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const limiter = make(1, 60000);
    limiter.hit('a');
    jest.setSystemTime(1_030_000);
    expect(limiter.hit('a')).toBe(30);
    jest.setSystemTime(1_060_001);
    expect(limiter.hit('a')).toBe(0);
  });
});
