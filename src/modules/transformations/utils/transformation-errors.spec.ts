import { HttpException } from '@nestjs/common';

import {
  classifyInputError,
  failureStatus,
  type FailureCode,
  toHttpException,
} from './transformation-errors';

const CODES: [FailureCode, number][] = [
  ['invalid_input', 400],
  ['conversion_failed', 400],
  ['input_too_large', 413],
  ['output_too_large', 413],
  ['unsupported_format', 415],
  ['unsupported_direction', 415],
  ['timeout', 504],
  ['dependency_unavailable', 503],
  ['temp_unavailable', 503],
  ['history_unavailable', 503],
];

describe('transformation errors', () => {
  it.each(CODES)(
    '%s maps to HTTP %i, in the status and in the body',
    (code, status) => {
      const error = toHttpException(code);

      expect(error).toBeInstanceOf(HttpException);
      expect(failureStatus(code)).toBe(status);
      expect(error.getStatus()).toBe(status);
      expect(error.getResponse()).toMatchObject({ statusCode: status });
    },
  );

  it('only the contract statuses are used', () => {
    const statuses = new Set(CODES.map(([, status]) => status));
    expect([...statuses].sort()).toEqual([400, 413, 415, 503, 504]);
  });

  it('the text is fixed per code: no library message, path or stack', () => {
    for (const [code] of CODES) {
      const body = JSON.stringify(toHttpException(code).getResponse());
      expect(body).not.toMatch(/stack|\.ts|node_modules|\/|\\\\/);
    }
  });

  it('503 carries one stable machine code, 504 its own', () => {
    expect(toHttpException('history_unavailable').getResponse()).toMatchObject({
      code: 'transformation_unavailable',
    });
    expect(toHttpException('timeout').getResponse()).toMatchObject({
      code: 'conversion_timeout',
    });
  });

  describe('classifyInputError', () => {
    it('the size limit is a 413', () => {
      expect(classifyInputError({ code: 'input_too_large' })).toBe(
        'input_too_large',
      );
      expect(classifyInputError({ code: 'FST_REQ_FILE_TOO_LARGE' })).toBe(
        'input_too_large',
      );
    });

    it('a file-system error is the server temp area failing', () => {
      expect(classifyInputError({ code: 'ENOSPC' })).toBe('temp_unavailable');
      expect(classifyInputError({ code: 'EACCES' })).toBe('temp_unavailable');
    });

    it('anything else is a broken upload', () => {
      expect(classifyInputError(new Error('aborted'))).toBe('invalid_input');
      expect(classifyInputError(null)).toBe('invalid_input');
      expect(classifyInputError({ code: 42 })).toBe('invalid_input');
    });
  });
});
