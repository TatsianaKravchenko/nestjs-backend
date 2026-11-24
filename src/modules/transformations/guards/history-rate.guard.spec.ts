import { HttpException, UnauthorizedException } from '@nestjs/common';

import { HistoryRateGuard } from './history-rate.guard';

const contextFor = (request: object) =>
  ({ switchToHttp: () => ({ getRequest: () => request }) }) as never;

describe('HistoryRateGuard', () => {
  const limiter = { hit: jest.fn() };
  const audit = { warn: jest.fn() };
  const guard = new HistoryRateGuard(limiter as never, audit as never);

  beforeEach(() => jest.resetAllMocks());

  it('allows a request within the limit, keyed by the actor id', () => {
    limiter.hit.mockReturnValue(0);
    expect(guard.canActivate(contextFor({ id: 'r', user: { id: 'u1' } }))).toBe(
      true,
    );
    expect(limiter.hit).toHaveBeenCalledWith('u1');
  });

  it('answers 429 with Retry-After seconds and logs ids only', () => {
    limiter.hit.mockReturnValue(7);
    let error: HttpException | undefined;
    try {
      guard.canActivate(contextFor({ id: 'r', user: { id: 'u1' } }));
    } catch (e) {
      error = e as HttpException;
    }
    expect(error?.getStatus()).toBe(429);
    expect(error?.getResponse()).toMatchObject({ retryAfterSeconds: 7 });
    expect(audit.warn).toHaveBeenCalledWith(
      'transformations.history.rate_limited',
      {
        requestId: 'r',
        actorUserId: 'u1',
        result: 'rate_limited',
        status: 429,
      },
    );
  });

  it('answers 401 without an authenticated user', () => {
    expect(() => guard.canActivate(contextFor({ id: 'r' }))).toThrow(
      UnauthorizedException,
    );
    expect(limiter.hit).not.toHaveBeenCalled();
  });
});
