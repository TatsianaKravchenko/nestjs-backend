import { BadRequestException, ExecutionContext } from '@nestjs/common';

import { USER_ID_PATTERN, UserIdFormatGuard } from './user-id-format.guard';

const ctx = (params: unknown) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ params }) }),
  }) as unknown as ExecutionContext;

describe('UserIdFormatGuard', () => {
  const guard = new UserIdFormatGuard();

  it.each([
    'a',
    '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44',
    'user_1-X',
    'x'.repeat(128),
  ])('accepts %s', (userId) => {
    expect(guard.canActivate(ctx({ userId }))).toBe(true);
  });

  it.each([
    '',
    'x'.repeat(129),
    'a b',
    'a/b',
    'a.b',
    "a'b",
    'юзер',
    'me%00',
    'a\nb',
  ])('rejects %j with 400', (userId) => {
    expect(() => guard.canActivate(ctx({ userId }))).toThrow(
      BadRequestException,
    );
  });

  it('rejects a missing or non-string id', () => {
    expect(() => guard.canActivate(ctx({}))).toThrow(BadRequestException);
    expect(() => guard.canActivate(ctx({ userId: ['a'] }))).toThrow(
      BadRequestException,
    );
  });

  it('exposes the documented pattern', () => {
    expect(USER_ID_PATTERN.test('ok-id_1')).toBe(true);
  });
});
