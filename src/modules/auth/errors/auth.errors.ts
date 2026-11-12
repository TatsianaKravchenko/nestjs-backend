import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

export enum ApiErrorCode {
  InvalidCredentials = 'invalid_credentials',
  InvalidSession = 'invalid_session',
  CsrfRejected = 'csrf_rejected',
  RateLimitExceeded = 'rate_limit_exceeded',
  ServiceUnavailable = 'service_unavailable',
  InternalError = 'internal_error',
  InvalidRequest = 'invalid_request',
  Forbidden = 'forbidden',
  PermissionDenied = 'permission_denied',
  OwnershipDenied = 'ownership_denied',
  AuthorizationUnavailable = 'authorization_unavailable',
  ValidationError = 'validation_error',
  InvalidConfirmation = 'invalid_confirmation',
  ConfirmationUnavailable = 'confirmation_unavailable',
  ConfirmationResendUnavailable = 'confirmation_resend_unavailable',
  EmailAlreadyRegistered = 'email_already_registered',
  LoginResendUnavailable = 'login_resend_unavailable',
}

export const TokenFailureReason = {
  Expired: 'expired',
  Claims: 'claims',
  Signature: 'signature',
  Malformed: 'malformed',
  TokenUse: 'token_use',
  Missing: 'missing',
  UserInactive: 'user_inactive',
} as const;
export type TokenFailureReason =
  (typeof TokenFailureReason)[keyof typeof TokenFailureReason];

export enum JwtErrorName {
  TokenExpired = 'TokenExpiredError',
  NotBefore = 'NotBeforeError',
}

export const JwtErrorMessage = {
  InvalidSignature: 'invalid signature',
  SignatureRequired: 'jwt signature is required',
  IssuerPrefix: 'jwt issuer',
  AudiencePrefix: 'jwt audience',
} as const;

const response = (
  statusCode: number,
  code: ApiErrorCode,
  message: string,
  extensions: Record<string, unknown> = {},
) => ({ statusCode, code, message, ...extensions });

export const invalidCredentials = (): UnauthorizedException =>
  new UnauthorizedException(
    response(
      HttpStatus.UNAUTHORIZED,
      ApiErrorCode.InvalidCredentials,
      'Invalid credentials',
    ),
  );

export const invalidSession = (): UnauthorizedException =>
  new UnauthorizedException(
    response(
      HttpStatus.UNAUTHORIZED,
      ApiErrorCode.InvalidSession,
      'Invalid session',
    ),
  );

export const csrfRejected = (): ForbiddenException =>
  new ForbiddenException(
    response(
      HttpStatus.FORBIDDEN,
      ApiErrorCode.CsrfRejected,
      'Request rejected',
    ),
  );

export const permissionDenied = (): ForbiddenException =>
  new ForbiddenException(
    response(
      HttpStatus.FORBIDDEN,
      ApiErrorCode.PermissionDenied,
      'Access denied',
    ),
  );

export const ownershipDenied = (): ForbiddenException =>
  new ForbiddenException(
    response(
      HttpStatus.FORBIDDEN,
      ApiErrorCode.OwnershipDenied,
      'Access denied',
    ),
  );

/** The user store, policy snapshot or route configuration cannot be trusted: fail closed. */
export const authorizationUnavailable = (): ServiceUnavailableException =>
  new ServiceUnavailableException(
    response(
      HttpStatus.SERVICE_UNAVAILABLE,
      ApiErrorCode.AuthorizationUnavailable,
      'Authorization is temporarily unavailable',
    ),
  );

export const rateLimitExceeded = (): HttpException =>
  new HttpException(
    response(
      HttpStatus.TOO_MANY_REQUESTS,
      ApiErrorCode.RateLimitExceeded,
      'Too many failed attempts',
    ),
    HttpStatus.TOO_MANY_REQUESTS,
  );

export const serviceUnavailable = (
  message = 'Service unavailable',
  extensions: Record<string, unknown> = {},
): ServiceUnavailableException =>
  new ServiceUnavailableException(
    response(
      HttpStatus.SERVICE_UNAVAILABLE,
      ApiErrorCode.ServiceUnavailable,
      message,
      extensions,
    ),
  );

export const invalidRequest = (
  message: string,
  code: ApiErrorCode = ApiErrorCode.InvalidRequest,
): BadRequestException =>
  new BadRequestException(response(HttpStatus.BAD_REQUEST, code, message));

export const invalidConfirmation = (): BadRequestException =>
  invalidRequest(
    'Invalid or expired confirmation',
    ApiErrorCode.InvalidConfirmation,
  );

export const loginDeliveryUnavailable = (
  method: string,
  attemptId: string,
  retryAfterSeconds: number,
): ServiceUnavailableException =>
  serviceUnavailable(
    'Could not send the email. Resend or log in again after the pause.',
    {
      code: ApiErrorCode.ConfirmationUnavailable,
      confirmationRequired: true,
      method,
      attemptId,
      retryAfterSeconds,
    },
  );

export const loginResendDeliveryUnavailable = (): ServiceUnavailableException =>
  serviceUnavailable('Could not send the email. Try again after the pause.', {
    code: ApiErrorCode.ConfirmationUnavailable,
  });

export const registrationDeliveryUnavailable =
  (): ServiceUnavailableException =>
    serviceUnavailable(
      'Could not send the confirmation email. Use resend to try again.',
      { code: ApiErrorCode.ConfirmationUnavailable },
    );

export const confirmationResendUnavailable = (): BadRequestException =>
  invalidRequest(
    'Registration cannot be resent',
    ApiErrorCode.ConfirmationResendUnavailable,
  );

export const loginResendUnavailable = (): BadRequestException =>
  invalidRequest('Login cannot be resent', ApiErrorCode.LoginResendUnavailable);

export const emailAlreadyRegistered = (): ConflictException =>
  new ConflictException(
    response(
      HttpStatus.CONFLICT,
      ApiErrorCode.EmailAlreadyRegistered,
      'Email is already registered',
    ),
  );

export const loginResendTooSoon = (retryAfterSeconds: number): HttpException =>
  new HttpException(
    response(
      HttpStatus.TOO_MANY_REQUESTS,
      ApiErrorCode.RateLimitExceeded,
      'A new email can be requested after the pause',
      { retryAfterSeconds },
    ),
    HttpStatus.TOO_MANY_REQUESTS,
  );

export const registrationResendTooSoon = (
  retryAfterSeconds: number,
): HttpException =>
  new HttpException(
    response(
      HttpStatus.TOO_MANY_REQUESTS,
      ApiErrorCode.RateLimitExceeded,
      `Resend is allowed once per ${retryAfterSeconds} seconds`,
      { retryAfterSeconds },
    ),
    HttpStatus.TOO_MANY_REQUESTS,
  );

export const registrationAttemptsExhausted = (): HttpException =>
  new HttpException(
    response(
      HttpStatus.TOO_MANY_REQUESTS,
      ApiErrorCode.RateLimitExceeded,
      'Too many failed attempts. Request a new code.',
    ),
    HttpStatus.TOO_MANY_REQUESTS,
  );

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  [extension: string]: unknown;
}

export const PROBLEM_DETAILS_SCHEMA = {
  type: 'object',
  required: ['type', 'title', 'status', 'detail', 'instance', 'code'],
  properties: {
    type: { type: 'string', format: 'uri-reference' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    instance: { type: 'string' },
    code: { type: 'string' },
  },
  additionalProperties: true,
};
