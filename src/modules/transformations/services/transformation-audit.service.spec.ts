import { Logger } from '@nestjs/common';

import {
  TransformationAuditService,
  type TransformationAuditFields,
} from './transformation-audit.service';

const base: TransformationAuditFields = {
  requestId: 'req-1',
  transformationId: '9b2f6a52-0f0c-4d1e-8a35-5b9e0f6c7a11',
  userId: '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44',
  type: 'file',
  sourceFormat: 'csv',
  targetFormat: 'json',
  inputSize: 10,
  outputSize: 20,
  durationMs: 5,
  result: 'success',
  status: 200,
};

describe('TransformationAuditService', () => {
  const service = new TransformationAuditService();
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('logs the contract fields at the matching level', () => {
    service.info('transformation.completed', base);
    service.warn('transformation.failed', {
      ...base,
      result: 'error',
      errorCode: 'timeout',
    });
    service.error('transformation.history_unavailable', base);

    expect(log).toHaveBeenCalledWith({
      event: 'transformation.completed',
      ...base,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'timeout', result: 'error' }),
    );
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('has no way to log a field outside the allow-list', () => {
    service.info('x', {
      ...base,
      fileName: 'passport.pdf',
      tempPath: '/tmp/job-1/input.bin',
      jwt: 'eyJhbGciOi',
      cookie: 'access_token=abc',
      stack: 'Error: boom\n at x',
      body: 'secret,data',
    } as TransformationAuditFields);

    const entry = (log.mock.calls as unknown[][])[0][0] as Record<
      string,
      unknown
    >;
    expect(Object.keys(entry).sort()).toEqual(
      [
        'event',
        'requestId',
        'transformationId',
        'userId',
        'type',
        'sourceFormat',
        'targetFormat',
        'inputSize',
        'outputSize',
        'durationMs',
        'result',
        'status',
      ].sort(),
    );
    expect(JSON.stringify(entry)).not.toMatch(
      /passport|job-1|eyJ|access_token|boom|secret/,
    );
  });

  it('replaces a string that is not a plain token, so a name or path cannot be logged', () => {
    service.info('x', {
      ...base,
      sourceFormat: '../../etc/passwd',
      targetFormat: 'my file.csv\n',
      requestId: 'a'.repeat(100),
    });

    expect((log.mock.calls as unknown[][])[0][0]).toMatchObject({
      sourceFormat: '?',
      targetFormat: '?',
      requestId: '?',
    });
  });

  it('skips undefined and non-finite numbers, keeps null', () => {
    service.info('x', {
      ...base,
      inputSize: Number.NaN,
      durationMs: undefined,
      outputSize: null,
    });

    const entry = (log.mock.calls as unknown[][])[0][0] as Record<
      string,
      unknown
    >;
    expect(entry).not.toHaveProperty('inputSize');
    expect(entry).not.toHaveProperty('durationMs');
    expect(entry.outputSize).toBeNull();
  });
});
