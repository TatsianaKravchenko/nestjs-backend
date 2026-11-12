import { ForbiddenException, Logger } from '@nestjs/common';

import { assertOwner } from './ownership';

describe('assertOwner', () => {
  afterEach(() => jest.restoreAllMocks());

  it('passes for the owner', () => {
    expect(() => assertOwner('u1', 'u1')).not.toThrow();
  });

  it('answers 403 ownership_denied for someone else and logs it', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    let error: unknown;
    try {
      assertOwner('u1', 'u2', {
        requestId: 'req-1',
        operation: 'UsersController.update',
        targetId: 'u2',
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: 'ownership_denied',
    });
    expect(warn).toHaveBeenCalledWith({
      event: 'ownership.denied',
      category: 'ownership_denied',
      status: 403,
      actorUserId: 'u1',
      requestId: 'req-1',
      operation: 'UsersController.update',
      targetId: 'u2',
    });
  });
});
