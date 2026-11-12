import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { ProblemDetails } from './auth.errors';
import { ProblemDetailsExceptionFilter } from './problem-details-exception.filter';

function run(exception: unknown, request: object = { url: '/x' }) {
  const sent: {
    status?: number;
    headers: Record<string, string>;
    body?: ProblemDetails;
  } = {
    headers: {},
  };
  const reply = {
    status: (s: number) => {
      sent.status = s;
    },
    header: (k: string, v: string) => {
      sent.headers[k] = v;
    },
    send: (b: ProblemDetails) => {
      sent.body = b;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
    }),
  } as unknown as ArgumentsHost;
  new ProblemDetailsExceptionFilter().catch(exception, host);
  return sent as Required<typeof sent>;
}

describe('ProblemDetailsExceptionFilter branches', () => {
  it('sends application/problem+json', () => {
    const out = run(new NotFoundException());
    expect(out.headers['content-type']).toBe('application/problem+json');
    expect(out.status).toBe(404);
  });

  it.each([
    [new BadRequestException('bad'), 'invalid_request'],
    [new UnauthorizedException(), 'invalid_session'],
    [new ForbiddenException(), 'forbidden'],
    [
      new HttpException('slow', HttpStatus.TOO_MANY_REQUESTS),
      'rate_limit_exceeded',
    ],
    [new ServiceUnavailableException(), 'service_unavailable'],
    [new HttpException('boom', HttpStatus.BAD_GATEWAY), 'internal_error'],
    [new ConflictException('dup'), 'invalid_request'],
  ])('defaults the code for %s to %s', (exception, code) => {
    expect(run(exception).body.code).toBe(code);
  });

  it('answers 500 internal_error without leaking a non-HTTP error', () => {
    const out = run(new Error('db password is hunter2'));
    expect(out.status).toBe(500);
    expect(out.body).toMatchObject({
      code: 'internal_error',
      detail: 'Internal server error',
    });
    expect(JSON.stringify(out.body)).not.toContain('hunter2');
  });

  it('reports validation messages as errors with validation_error', () => {
    const out = run(new BadRequestException(['a must be b', 'c is required']));
    expect(out.body).toMatchObject({
      code: 'validation_error',
      detail: 'Request validation failed',
      errors: ['a must be b', 'c is required'],
    });
  });

  it('uses the payload code and message, and copies extensions', () => {
    const out = run(
      new HttpException(
        {
          statusCode: 429,
          code: 'rate_limit_exceeded',
          message: 'Slow down',
          retryAfterSeconds: 30,
        },
        429,
      ),
    );
    expect(out.body).toMatchObject({
      detail: 'Slow down',
      retryAfterSeconds: 30,
    });
    expect(out.body).not.toHaveProperty('statusCode');
  });

  it('prefers an explicit detail', () => {
    const out = run(new HttpException({ detail: 'Specific', code: 'x' }, 409));
    expect(out.body.detail).toBe('Specific');
  });

  it('falls back to the status text for an unstructured 4xx', () => {
    const out = run(new HttpException({ code: undefined }, 418));
    expect(out.body.detail).toBe("I'm a Teapot");
  });

  it('hides the message of a 5xx without a code', () => {
    const out = run(new HttpException({ message: 'secret internals' }, 502));
    expect(out.body.detail).toBe('Internal server error');
  });

  it('shows the message of a 5xx that carries a code', () => {
    const out = run(
      new HttpException({ code: 'upstream', message: 'Upstream down' }, 502),
    );
    expect(out.body.detail).toBe('Upstream down');
  });

  it.each([
    [{ raw: { url: '/raw?x=1' }, url: '/other' }, '/raw?x=1'],
    [{ url: '/plain' }, '/plain'],
    [{}, '/'],
  ])('sets instance from %j', (request, instance) => {
    expect(run(new NotFoundException(), request).body.instance).toBe(instance);
  });
});
