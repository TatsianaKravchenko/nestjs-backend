import { SlidingWindow } from './sliding-window';

describe('SlidingWindow', () => {
  afterEach(() => jest.useRealTimers());

  it('allows hits below the limit and reports the wait once it is full', () => {
    jest.useFakeTimers().setSystemTime(0);
    const window = new SlidingWindow();
    expect(window.retryAfter('k', 2, 10_000)).toBe(0);
    window.record('k', 10_000);
    window.record('k', 10_000);
    jest.setSystemTime(4_000);
    expect(window.retryAfter('k', 2, 10_000)).toBe(6);
    expect(window.retryAfter('other', 2, 10_000)).toBe(0);
  });

  it('forgets hits outside the window', () => {
    jest.useFakeTimers().setSystemTime(0);
    const window = new SlidingWindow();
    window.record('k', 1_000);
    jest.setSystemTime(1_001);
    expect(window.retryAfter('k', 1, 1_000)).toBe(0);
  });

  it('sweeps expired keys when the map grows large', () => {
    jest.useFakeTimers().setSystemTime(0);
    const window = new SlidingWindow();
    for (let i = 0; i <= 10_000; i++) window.record(`k${i}`, 1_000);
    jest.setSystemTime(5_000);
    window.record('fresh', 1_000);
    expect(window.retryAfter('k1', 1, 1_000)).toBe(0);
    expect(window.retryAfter('fresh', 1, 1_000)).toBeGreaterThan(0);
  });
});
