import { BadRequestException } from '@nestjs/common';

import { invalidCredentials, loginResendTooSoon } from './auth.errors';
import { ProblemDetailsExceptionFilter } from './problem-details-exception.filter';

function run(exception: unknown) {
  const reply = {
    status: jest.fn().mockReturnThis(),
    header: jest.fn().mockReturnThis(),
    send: jest.fn(),
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ url: '/auth/login', raw: { url: '/auth/login' } }),
      getResponse: () => reply,
    }),
  };

  new ProblemDetailsExceptionFilter().catch(exception, host as never);
  return reply;
}

describe('ProblemDetailsExceptionFilter', () => {
  it('serializes the neutral login refusal as RFC 9457 Problem Details', () => {
    const reply = run(invalidCredentials());

    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply.header).toHaveBeenCalledWith(
      'content-type',
      'application/problem+json',
    );
    expect(reply.send).toHaveBeenCalledWith({
      type: 'https://api.example.com/errors/invalid-credentials',
      title: 'Unauthorized',
      status: 401,
      detail: 'Invalid credentials',
      instance: '/auth/login',
      code: 'invalid_credentials',
    });
  });

  it('serializes validation errors and retains the validation messages', () => {
    const reply = run(
      new BadRequestException({
        statusCode: 400,
        message: ['email must be an email'],
        error: 'Bad Request',
      }),
    );

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'https://api.example.com/errors/validation-error',
        title: 'Bad Request',
        status: 400,
        detail: 'Request validation failed',
        instance: '/auth/login',
        code: 'validation_error',
        errors: ['email must be an email'],
      }),
    );
  });

  it('retains rate-limit extension fields', () => {
    const exception = loginResendTooSoon(30);
    const reply = run(exception);

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 429,
        code: 'rate_limit_exceeded',
        retryAfterSeconds: 30,
      }),
    );
  });
});
