/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { HttpException } from '@nestjs/common';
import { mkdtemp, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

import { TransformationStatus } from '../entities/transformation.entity';
import { StorageStatus } from '../entities/transformation-object.entity';
import {
  ConverterFailure,
  type ConversionRequest,
  type Converter,
  type ConverterErrorCode,
} from './converter';
import { ConverterRegistry } from './converter.registry';
import type { ResultStore } from './result-store';
import { TempStorageService } from './temp-storage.service';
import type { TransformationAuditService } from './transformation-audit.service';
import type {
  AttemptRecord,
  TransformationHistoryService,
} from './transformation-history.service';
import { TransformationService } from './transformation.service';

const USER_ID = '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44';
const SECRET = 'SECRET-library-message /srv/private/path';
const BODY = 'a,b\n1,2\n';

const limits = { maxInputBytes: 1024, maxOutputBytes: 1024, timeoutMs: 2000 };

function converter(
  convert: (request: ConversionRequest) => ReturnType<Converter['convert']>,
  overrides: Partial<Converter> = {},
): Converter {
  return {
    type: 'file' as Converter['type'],
    source: 'csv',
    target: 'json',
    limits,
    convert,
    ...overrides,
  };
}

/** Copies the input to the output. */
const echo = (): Converter =>
  converter(async ({ input, output }) => {
    await pipeline(input, output);
    return {
      ok: true as const,
      contentType: 'application/json',
      extension: 'json',
      size: 0,
    };
  });

const upload = (text = BODY) => Readable.from([Buffer.from(text)]);

async function rejection(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected a rejection');
}

describe('TransformationService', () => {
  let base: string;
  let registry: ConverterRegistry;
  let temp: TempStorageService;
  let history: { record: jest.Mock };
  let audit: { info: jest.Mock; warn: jest.Mock; error: jest.Mock };
  let store: { retain: jest.Mock; delete: jest.Mock };
  let service: TransformationService;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'transformation-spec-'));
    const config = {
      get: (key: string) =>
        ({
          TRANSFORM_TEMP_DIR: base,
          TRANSFORM_TEMP_SWEEP_MAX_AGE_MS: 3600000,
        })[key],
    };
    registry = new ConverterRegistry();
    temp = new TempStorageService(config as never);
    history = { record: jest.fn().mockResolvedValue(undefined) };
    audit = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    store = {
      retain: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue('deleted'),
    };
    service = new TransformationService(
      registry,
      temp,
      history as unknown as TransformationHistoryService,
      audit as unknown as TransformationAuditService,
      store as unknown as ResultStore,
    );
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const command = (overrides = {}) => ({
    requestId: 'req-1',
    userId: USER_ID,
    sourceFormat: 'csv',
    targetFormat: 'json',
    input: upload(),
    ...overrides,
  });

  const lastRecord = (): AttemptRecord =>
    history.record.mock.calls[0][0] as AttemptRecord;

  async function expectTempEmpty(): Promise<void> {
    // The job directory goes away when the result stream closes: wait for it.
    for (let attempt = 0; attempt < 150; attempt++) {
      if ((await readdir(base)).length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await readdir(base)).toEqual([]);
  }

  async function readAll(stream: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  describe('success', () => {
    it('selects the converter by pair, returns the whole result and records success', async () => {
      registry.register(echo());

      const result = await service.convert(
        command({ sourceFormat: ' CSV ', targetFormat: 'Json' }),
      );

      expect(result).toMatchObject({
        contentType: 'application/json',
        extension: 'json',
        size: BODY.length,
      });
      expect(await readAll(result.stream)).toBe(BODY);
      expect(history.record).toHaveBeenCalledTimes(1);
      const record = lastRecord();
      expect(record).toMatchObject({
        id: result.transformationId,
        userId: USER_ID,
        type: 'file',
        sourceFormat: 'csv',
        targetFormat: 'json',
        status: TransformationStatus.SUCCESS,
        inputSize: BODY.length,
        outputSize: BODY.length,
        errorCode: null,
      });
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
      expect(record.completedAt.getTime()).toBeGreaterThanOrEqual(
        record.createdAt.getTime(),
      );
      expect(record.object).toBeUndefined();
      expect(result.storageStatus).toBeUndefined();
      expect(audit.info).toHaveBeenCalledWith(
        'transformation.completed',
        expect.objectContaining({ result: 'success', status: 200 }),
      );
    });

    it('removes the temp files once the result stream closes', async () => {
      registry.register(echo());
      const result = await service.convert(command());
      expect(await readdir(base)).toHaveLength(1);

      await readAll(result.stream);
      await expectTempEmpty();
    });

    it('removes the temp files when the client abandons the result', async () => {
      registry.register(echo());
      const result = await service.convert(command());

      result.stream.destroy();
      await expectTempEmpty();
    });

    it('gives the converter its params and an abort signal', async () => {
      const convert = jest.fn(async ({ input, output }: ConversionRequest) => {
        await pipeline(input, output);
        return {
          ok: true as const,
          contentType: 'text/plain',
          extension: 'txt',
          size: 0,
        };
      });
      registry.register(converter(convert));

      const result = await service.convert(
        command({ params: { pretty: true } }),
      );
      result.stream.destroy();

      const request = convert.mock.calls[0][0];
      expect(request.params).toEqual({ pretty: true });
      expect(request.signal.aborted).toBe(false);
      await expectTempEmpty();
    });

    it('the converter is decoupled from the caller: it never sees the user or the request', async () => {
      const convert = jest.fn(async ({ input, output }: ConversionRequest) => {
        await pipeline(input, output);
        return {
          ok: true as const,
          contentType: 'text/plain',
          extension: 'txt',
          size: 0,
        };
      });
      registry.register(converter(convert));

      const result = await service.convert(command());
      result.stream.destroy();

      expect(Object.keys(convert.mock.calls[0][0]).sort()).toEqual([
        'input',
        'output',
        'params',
        'signal',
      ]);
      await expectTempEmpty();
    });
  });

  describe('rejections before conversion (not recorded)', () => {
    it('415 for an unregistered pair, and drains the upload', async () => {
      registry.register(echo());
      const input = upload();
      const resume = jest.spyOn(input, 'resume');

      const error = await rejection(
        service.convert(command({ targetFormat: 'yaml', input })),
      );

      expect(error.getStatus()).toBe(415);
      expect(resume).toHaveBeenCalled();
      expect(history.record).not.toHaveBeenCalled();
      expect(await readdir(base)).toEqual([]);
    });

    it('415 for a format name that is not a plain token', async () => {
      registry.register(echo());
      const error = await rejection(
        service.convert(command({ sourceFormat: '../etc/passwd' })),
      );
      expect(error.getStatus()).toBe(415);
    });

    it('413 when the upload exceeds the limit of the direction', async () => {
      registry.register(
        converter((request) => echo().convert(request), {
          limits: { ...limits, maxInputBytes: 4 },
        }),
      );

      const error = await rejection(service.convert(command()));

      expect(error.getStatus()).toBe(413);
      expect(history.record).not.toHaveBeenCalled();
      await expectTempEmpty();
    });

    it('413 when the HTTP layer reports a truncated upload', async () => {
      registry.register(echo());
      const error = await rejection(
        service.convert(command({ isTruncated: () => true })),
      );
      expect(error.getStatus()).toBe(413);
      await expectTempEmpty();
    });

    it('400 for an empty upload', async () => {
      registry.register(echo());
      const error = await rejection(
        service.convert(command({ input: upload('') })),
      );
      expect(error.getStatus()).toBe(400);
      expect(history.record).not.toHaveBeenCalled();
      await expectTempEmpty();
    });

    it('400 when the upload stream breaks', async () => {
      registry.register(echo());
      const input = new Readable({
        read() {
          this.destroy(new Error('aborted by the client'));
        },
      });
      const error = await rejection(service.convert(command({ input })));
      expect(error.getStatus()).toBe(400);
      await expectTempEmpty();
    });

    it('503 when the temp area is unavailable', async () => {
      registry.register(echo());
      jest.spyOn(temp, 'create').mockRejectedValue(new Error('EACCES'));

      const error = await rejection(service.convert(command()));

      expect(error.getStatus()).toBe(503);
      expect(history.record).not.toHaveBeenCalled();
    });

    it('503 when writing the upload to the temp file fails', async () => {
      registry.register(echo());
      const input = new Readable({
        read() {
          this.destroy(
            Object.assign(new Error('no space'), { code: 'ENOSPC' }),
          );
        },
      });
      const error = await rejection(service.convert(command({ input })));
      expect(error.getStatus()).toBe(503);
    });

    it('logs the rejection without the file or the original name', async () => {
      registry.register(echo());
      await rejection(service.convert(command({ targetFormat: 'yaml' })));
      expect(audit.warn).toHaveBeenCalledWith(
        'transformation.rejected',
        expect.objectContaining({
          requestId: 'req-1',
          userId: USER_ID,
          result: 'rejected',
          errorCode: 'unsupported_direction',
          status: 415,
        }),
      );
    });
  });

  describe('library errors (recorded)', () => {
    it.each<[ConverterErrorCode, number]>([
      ['invalid_input', 400],
      ['conversion_failed', 400],
      ['input_too_large', 413],
      ['output_too_large', 413],
      ['unsupported_format', 415],
      ['timeout', 504],
      ['dependency_unavailable', 503],
    ])(
      'a reported %s becomes HTTP %i and an error row',
      async (code, status) => {
        registry.register(
          converter(() => Promise.resolve({ ok: false, code })),
        );

        const error = await rejection(service.convert(command()));

        expect(error.getStatus()).toBe(status);
        expect(lastRecord()).toMatchObject({
          status: TransformationStatus.ERROR,
          outputSize: null,
          errorCode: code,
          inputSize: BODY.length,
        });
        await expectTempEmpty();
      },
    );

    it('an unexpected exception is a safe 400 and its message never leaks', async () => {
      registry.register(converter(() => Promise.reject(new Error(SECRET))));

      const error = await rejection(service.convert(command()));

      expect(error.getStatus()).toBe(400);
      expect(JSON.stringify(error.getResponse())).not.toContain('SECRET');
      expect(lastRecord().errorCode).toBe('conversion_failed');
      expect(
        JSON.stringify([audit.warn.mock.calls, audit.error.mock.calls]),
      ).not.toContain('SECRET');
      await expectTempEmpty();
    });

    it('a ConverterFailure carries its safe code', async () => {
      registry.register(
        converter(() =>
          Promise.reject(new ConverterFailure('dependency_unavailable')),
        ),
      );
      const error = await rejection(service.convert(command()));
      expect(error.getStatus()).toBe(503);
      expect(lastRecord().errorCode).toBe('dependency_unavailable');
    });

    it('an unknown code reported by a converter is treated as conversion_failed', async () => {
      registry.register(
        converter(() =>
          Promise.resolve({ ok: false, code: 'weird' as ConverterErrorCode }),
        ),
      );
      const error = await rejection(service.convert(command()));
      expect(error.getStatus()).toBe(400);
      expect(lastRecord().errorCode).toBe('conversion_failed');
    });

    it('a result above the output limit is a 413 and nothing is returned', async () => {
      registry.register(
        converter(
          async ({ output }) => {
            await pipeline(Readable.from([Buffer.alloc(64, 1)]), output);
            return {
              ok: true,
              contentType: 'text/plain',
              extension: 'txt',
              size: 64,
            };
          },
          { limits: { ...limits, maxOutputBytes: 16 } },
        ),
      );

      const error = await rejection(service.convert(command()));

      expect(error.getStatus()).toBe(413);
      expect(lastRecord()).toMatchObject({
        status: TransformationStatus.ERROR,
        errorCode: 'output_too_large',
      });
      await expectTempEmpty();
    });

    it('a converter that reports success without output is a failure', async () => {
      registry.register(
        converter(() =>
          Promise.resolve({
            ok: true,
            contentType: 'text/plain',
            extension: 'txt',
            size: 0,
          }),
        ),
      );
      const error = await rejection(service.convert(command()));
      expect(error.getStatus()).toBe(400);
      expect(lastRecord().errorCode).toBe('conversion_failed');
    });

    it.each([
      [
        'content type',
        { contentType: 'text/plain\r\nX-Evil: 1', extension: 'txt' },
      ],
      ['extension', { contentType: 'text/plain', extension: '../x' }],
    ])('an unusable %s is a failure', async (_label, bad) => {
      registry.register(
        converter(async ({ input, output }) => {
          await pipeline(input, output);
          return { ok: true, size: 1, ...bad };
        }),
      );
      const error = await rejection(service.convert(command()));
      expect(error.getStatus()).toBe(400);
      await expectTempEmpty();
    });

    it('logs the failure with ids and a code only', async () => {
      registry.register(converter(() => Promise.reject(new Error(SECRET))));
      await rejection(service.convert(command()));

      expect(audit.warn).toHaveBeenCalledWith(
        'transformation.failed',
        expect.objectContaining({
          userId: USER_ID,
          type: 'file',
          sourceFormat: 'csv',
          targetFormat: 'json',
          inputSize: BODY.length,
          result: 'error',
          errorCode: 'conversion_failed',
          status: 400,
        }),
      );
    });
  });

  describe('timeout', () => {
    it('504, aborts the converter, records it and cleans up', async () => {
      let signal: AbortSignal | undefined;
      registry.register(
        converter(
          (request) => {
            signal = request.signal;
            return new Promise((_resolve, reject) => {
              request.signal.addEventListener('abort', () =>
                reject(new Error('aborted')),
              );
            });
          },
          { limits: { ...limits, timeoutMs: 30 } },
        ),
      );

      const error = await rejection(service.convert(command()));

      expect(error.getStatus()).toBe(504);
      expect(signal?.aborted).toBe(true);
      expect(lastRecord()).toMatchObject({
        status: TransformationStatus.ERROR,
        errorCode: 'timeout',
      });
      await expectTempEmpty();
    });

    it('does not wait forever for a converter that ignores the abort', async () => {
      registry.register(
        converter(() => new Promise(() => undefined), {
          limits: { ...limits, timeoutMs: 30 },
        }),
      );

      const started = Date.now();
      const error = await rejection(service.convert(command()));

      expect(error.getStatus()).toBe(504);
      expect(Date.now() - started).toBeLessThan(4000);
      await expectTempEmpty();
    });
  });

  describe('mandatory history', () => {
    it('503 and no result when the success row cannot be written', async () => {
      registry.register(echo());
      history.record.mockRejectedValue(new Error('connection lost'));

      const error = await rejection(service.convert(command()));

      expect(error.getStatus()).toBe(503);
      expect(JSON.stringify(error.getResponse())).not.toContain('connection');
      await expectTempEmpty();
      expect(audit.error).toHaveBeenCalledWith(
        'transformation.history_unavailable',
        expect.objectContaining({
          errorCode: 'history_unavailable',
          status: 503,
        }),
      );
    });

    it('503 when the error row cannot be written either', async () => {
      registry.register(
        converter(() => Promise.resolve({ ok: false, code: 'invalid_input' })),
      );
      history.record.mockRejectedValue(new Error('down'));

      const error = await rejection(service.convert(command()));

      expect(error.getStatus()).toBe(503);
      await expectTempEmpty();
    });

    it('removes the retained copy when the history write fails', async () => {
      registry.register(echo());
      history.record.mockRejectedValue(new Error('down'));

      await rejection(service.convert(command({ save: true })));

      const key = store.retain.mock.calls[0][0] as string;
      expect(store.delete).toHaveBeenCalledWith(key);
      await expectTempEmpty();
    });
  });

  describe('rejectAttempt (an upload refused after it was read)', () => {
    const attempt = (overrides = {}) => ({
      requestId: 'req-9',
      userId: USER_ID,
      sourceFormat: 'CSV',
      targetFormat: ' JSON ',
      inputSize: 12,
      startedAt: new Date(Date.now() - 50),
      ...overrides,
    });

    it('records an error row with a safe code and throws the matching 400', async () => {
      const error = await rejection(
        service.rejectAttempt(attempt(), 'invalid_input'),
      );

      expect(error.getStatus()).toBe(400);
      expect(lastRecord()).toMatchObject({
        userId: USER_ID,
        type: 'file',
        sourceFormat: 'csv',
        targetFormat: 'json',
        status: TransformationStatus.ERROR,
        inputSize: 12,
        outputSize: null,
        errorCode: 'invalid_input',
      });
      expect(lastRecord().durationMs).toBeGreaterThanOrEqual(0);
      expect(audit.warn).toHaveBeenCalledWith(
        'transformation.failed',
        expect.objectContaining({
          requestId: 'req-9',
          result: 'error',
          errorCode: 'invalid_input',
          status: 400,
        }),
      );
    });

    it.each([[''], ['not a format!'], ['x'.repeat(40)]])(
      'stores an unusable target (%p) as "unknown"',
      async (targetFormat) => {
        await rejection(
          service.rejectAttempt(attempt({ targetFormat }), 'invalid_input'),
        );
        expect(lastRecord().targetFormat).toBe('unknown');
      },
    );

    it('answers 503 when the error row cannot be written', async () => {
      history.record.mockRejectedValue(new Error('down'));

      const error = await rejection(
        service.rejectAttempt(attempt(), 'invalid_input'),
      );

      expect(error.getStatus()).toBe(503);
      expect(audit.error).toHaveBeenCalledWith(
        'transformation.history_unavailable',
        expect.objectContaining({ errorCode: 'history_unavailable' }),
      );
    });
  });

  describe('save=true', () => {
    it('keeps a copy under an opaque key and reports pending without waiting for storage', async () => {
      registry.register(echo());

      const result = await service.convert(command({ save: true }));

      expect(result.storageStatus).toBe('pending');
      const [key, path] = store.retain.mock.calls[0] as [string, string];
      expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(path.startsWith(base)).toBe(true);
      expect(lastRecord().object).toEqual({
        key,
        status: StorageStatus.PENDING,
      });
      expect(await readAll(result.stream)).toBe(BODY);
      await expectTempEmpty();
    });

    it('still returns the result when the copy cannot be retained, marked failed', async () => {
      registry.register(echo());
      store.retain.mockRejectedValue(new Error('disk full'));

      const result = await service.convert(command({ save: true }));

      expect(result.storageStatus).toBe('failed');
      expect(lastRecord().object?.status).toBe(StorageStatus.FAILED);
      result.stream.destroy();
      await expectTempEmpty();
    });

    it('keeps nothing without the flag, and for a failed conversion', async () => {
      registry.register(echo());
      const result = await service.convert(command());
      result.stream.destroy();
      expect(store.retain).not.toHaveBeenCalled();

      registry.register(
        converter(() => Promise.resolve({ ok: false, code: 'invalid_input' }), {
          source: 'xml',
        }),
      );
      await rejection(
        service.convert(command({ sourceFormat: 'xml', save: true })),
      );
      expect(store.retain).not.toHaveBeenCalled();
      await expectTempEmpty();
    });
  });
});
