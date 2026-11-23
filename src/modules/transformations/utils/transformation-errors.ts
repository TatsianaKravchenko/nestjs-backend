import { HttpException } from '@nestjs/common';

import {
  ApiErrorCode,
  gatewayTimeout,
  invalidRequest,
  payloadTooLarge,
  serviceUnavailable,
  unsupportedMediaType,
} from '@/modules/auth/errors/auth.errors';

import type { ConverterErrorCode } from '../services/converter';

/** Everything that can end an attempt unsuccessfully. */
export type FailureCode =
  | ConverterErrorCode
  | 'unsupported_direction'
  | 'temp_unavailable'
  | 'history_unavailable';

const STATUS: Record<FailureCode, number> = {
  invalid_input: 400,
  conversion_failed: 400,
  input_too_large: 413,
  output_too_large: 413,
  image_too_large: 413,
  unsupported_format: 415,
  unsupported_direction: 415,
  timeout: 504,
  dependency_unavailable: 503,
  temp_unavailable: 503,
  history_unavailable: 503,
};

export const failureStatus = (code: FailureCode): number => STATUS[code];

/**
 * The client-facing error of a failure code. The text is fixed per code: a
 * library message, a path or a stack trace is never part of it.
 */
export function toHttpException(code: FailureCode): HttpException {
  switch (code) {
    case 'invalid_input':
      return invalidRequest('The file or the parameters are invalid');
    case 'conversion_failed':
      return invalidRequest(
        'The file content could not be converted',
        ApiErrorCode.ConversionFailed,
      );
    case 'input_too_large':
      return payloadTooLarge('The file exceeds the size limit');
    case 'output_too_large':
      return payloadTooLarge('The result exceeds the size limit');
    case 'image_too_large':
      return payloadTooLarge('The image dimensions exceed the limit');
    case 'unsupported_format':
    case 'unsupported_direction':
      return unsupportedMediaType('This conversion is not supported');
    case 'timeout':
      return gatewayTimeout('The conversion did not finish in time');
    case 'dependency_unavailable':
    case 'temp_unavailable':
    case 'history_unavailable':
      return serviceUnavailable('The conversion is temporarily unavailable', {
        code: ApiErrorCode.TransformationUnavailable,
      });
  }
}

const IO_ERRNO = /^E[A-Z0-9]+$/;

/**
 * Classifies a failure while the upload is copied to the temp file: the
 * size limit is a 413, a file-system error is the server's problem (503) and
 * anything else (a broken or aborted upload) is the client's (400).
 */
export function classifyInputError(error: unknown): FailureCode {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'input_too_large' || code === 'FST_REQ_FILE_TOO_LARGE') {
    return 'input_too_large';
  }
  return typeof code === 'string' && IO_ERRNO.test(code)
    ? 'temp_unavailable'
    : 'invalid_input';
}
