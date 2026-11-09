import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { STATUS_CODES } from 'http';

import { ApiErrorCode, ProblemDetails } from './auth.errors';

interface ExceptionPayload {
  code?: string;
  message?: string | string[];
  detail?: string;
  [key: string]: unknown;
}

@Catch()
export class ProblemDetailsExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<{ url?: string; raw?: { url?: string } }>();
    const reply = http.getResponse<{
      status: (status: number) => unknown;
      header: (name: string, value: string) => unknown;
      send: (body: ProblemDetails) => unknown;
    }>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const payload: ExceptionPayload =
      typeof raw === 'string'
        ? { message: raw }
        : raw && typeof raw === 'object'
          ? (raw as ExceptionPayload)
          : {};
    const validationMessages =
      status === Number(HttpStatus.BAD_REQUEST) &&
      Array.isArray(payload.message)
        ? payload.message
        : undefined;
    const code =
      payload.code ??
      (validationMessages
        ? ApiErrorCode.ValidationError
        : this.defaultCode(status));
    const detail =
      payload.detail ??
      (typeof payload.message === 'string' &&
      (status < Number(HttpStatus.INTERNAL_SERVER_ERROR) || payload.code)
        ? payload.message
        : validationMessages
          ? 'Request validation failed'
          : status >= Number(HttpStatus.INTERNAL_SERVER_ERROR)
            ? 'Internal server error'
            : (STATUS_CODES[status] ?? 'Request failed'));
    const problem: ProblemDetails = {
      type: `https://api.example.com/errors/${code.replace(/_/g, '-')}`,
      title: STATUS_CODES[status] ?? 'Error',
      status,
      detail,
      instance: request.raw?.url ?? request.url ?? '/',
      code,
    };

    if (validationMessages) problem.errors = validationMessages;
    for (const [key, value] of Object.entries(payload)) {
      if (!['statusCode', 'code', 'message', 'detail', 'error'].includes(key)) {
        problem[key] = value;
      }
    }

    void reply.status(status);
    void reply.header('content-type', 'application/problem+json');
    void reply.send(problem);
  }

  private defaultCode(status: number): string {
    switch (status) {
      case Number(HttpStatus.BAD_REQUEST):
        return ApiErrorCode.InvalidRequest;
      case Number(HttpStatus.UNAUTHORIZED):
        return ApiErrorCode.InvalidSession;
      case Number(HttpStatus.FORBIDDEN):
        return ApiErrorCode.Forbidden;
      case Number(HttpStatus.TOO_MANY_REQUESTS):
        return ApiErrorCode.RateLimitExceeded;
      case Number(HttpStatus.SERVICE_UNAVAILABLE):
        return ApiErrorCode.ServiceUnavailable;
      default:
        return status >= Number(HttpStatus.INTERNAL_SERVER_ERROR)
          ? ApiErrorCode.InternalError
          : ApiErrorCode.InvalidRequest;
    }
  }
}
