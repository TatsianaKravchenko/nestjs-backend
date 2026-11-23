import { HttpException, Inject, Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { stat } from 'fs/promises';
import { performance } from 'perf_hooks';
import type { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { setTimeout as sleep } from 'timers/promises';

import {
  TransformationStatus,
  TransformationType,
} from '../entities/transformation.entity';
import { StorageStatus } from '../entities/transformation-object.entity';
import { ByteLimit, ByteLimitError } from '../utils/byte-limit';
import {
  isContentType,
  isExtension,
  isFormat,
  normalizeFormat,
} from '../utils/formats';
import {
  classifyInputError,
  failureStatus,
  type FailureCode,
  toHttpException,
} from '../utils/transformation-errors';
import {
  CONVERTER_ERROR_CODES,
  ConverterFailure,
  type ConversionOutcome,
  type ConversionRequest,
  type Converter,
  type ConverterParams,
} from './converter';
import { ConverterRegistry } from './converter.registry';
import { RESULT_STORE, type ResultStore } from './result-store';
import { TempStorageService, type Workspace } from './temp-storage.service';
import {
  type AttemptRecord,
  TransformationHistoryService,
} from './transformation-history.service';
import { TransformationAuditService } from './transformation-audit.service';

/** How long a stuck converter may take to react to the abort before cleanup. */
const ABORT_GRACE_MS = 1000;
/** Safety net: a result stream nobody reads is destroyed (and its files removed). */
const RESULT_TTL_MS = 5 * 60 * 1000;

/** Opaque storage key: 192 random bits, no user id, no file name. */
export const newResultKey = (): string => randomBytes(24).toString('base64url');

export interface ConvertCommand {
  requestId: string;
  /** The verified id of the authenticated user (set by the guards). */
  userId: string;
  /** Detected by the caller (extension, MIME, signature); never trusted for paths. */
  sourceFormat: string;
  targetFormat: string;
  /** Parameters already validated by the caller (DTO). */
  params?: ConverterParams;
  /** The uploaded file. The service copies it to the temp area under a server-chosen name. */
  input: Readable;
  /** True when the HTTP layer cut the upload at its own limit (multipart `truncated`). */
  isTruncated?: () => boolean;
  /** `save=true`: keep a copy for background persistence (task 2.4). */
  save?: boolean;
}

export interface ConvertResult {
  transformationId: string;
  contentType: string;
  extension: string;
  size: number;
  /** The whole result. Its temp files are removed when the stream closes. */
  stream: Readable;
  /** Set only for `save=true`. */
  storageStatus?: 'pending' | 'failed';
}

type AttemptOutcome =
  | { ok: true; contentType: string; extension: string; size: number }
  | { ok: false; code: FailureCode };

interface Context {
  id: string;
  cmd: ConvertCommand;
  source: string;
  target: string;
  type: string;
}

/** What the audit and the error mapping need to know about an attempt. */
type Identity = Pick<Context, 'id' | 'source' | 'target' | 'type'> & {
  cmd: Pick<ConvertCommand, 'requestId' | 'userId'>;
};

/**
 * An upload that was read completely but is not a valid request (for example
 * unexpected multipart parts). It is recorded as an error, never as a success.
 */
export interface RejectedAttempt {
  requestId: string;
  userId: string;
  sourceFormat: string;
  /** May be missing or invalid: it is stored as `unknown` then. */
  targetFormat: string;
  inputSize: number;
  /** Defaults to `file`. */
  type?: TransformationType;
  startedAt: Date;
}

/**
 * The shared pipeline behind every conversion endpoint. Authentication, CSRF
 * and `transformations@convert` are checked by the route's guards before the
 * file is read (403 comes first). From there:
 *
 * format lookup (415) -> private temp job directory (503) -> copy the upload
 * with the size limit (413/400) -> run the converter with a timeout (504) into
 * a temp file -> write the history (503 and no result when it fails) -> hand
 * the whole result over. The temp directory is removed on every path: on
 * success when the result stream closes, otherwise before this method throws.
 *
 * A history row is written for every attempt that reached a converter. A
 * request that was rejected earlier (unsupported pair, bad or too large upload,
 * temp area down) is only logged: nothing was converted, and its input size is
 * not known.
 *
 * Errors are fixed per code; a library message or stack trace never reaches the
 * client, the history or the log.
 */
@Injectable()
export class TransformationService {
  constructor(
    private readonly registry: ConverterRegistry,
    private readonly temp: TempStorageService,
    private readonly history: TransformationHistoryService,
    private readonly audit: TransformationAuditService,
    @Inject(RESULT_STORE) private readonly store: ResultStore,
  ) {}

  async convert(cmd: ConvertCommand): Promise<ConvertResult> {
    const startedAt = new Date();
    const t0 = performance.now();
    const source = normalizeFormat(cmd.sourceFormat);
    const target = normalizeFormat(cmd.targetFormat);
    const converter =
      isFormat(source) && isFormat(target)
        ? this.registry.find(source, target)
        : undefined;
    const ctx: Context = {
      id: randomUUID(),
      cmd,
      source,
      target,
      type: converter?.type ?? 'unknown',
    };

    if (!converter) {
      cmd.input.resume();
      throw this.reject(ctx, 'unsupported_direction');
    }

    let workspace: Workspace;
    try {
      workspace = await this.temp.create();
    } catch {
      cmd.input.resume();
      throw this.reject(ctx, 'temp_unavailable');
    }

    let handedOver = false;
    try {
      const inputSize = await this.spool(ctx, converter, workspace);
      const attempt = await this.attempt(converter, cmd, workspace);
      const completedAt = new Date();
      const durationMs = Math.max(0, Math.round(performance.now() - t0));

      const object =
        attempt.ok && cmd.save ? await this.retain(workspace) : undefined;
      const record: AttemptRecord = {
        id: ctx.id,
        userId: cmd.userId,
        type: converter.type,
        sourceFormat: source,
        targetFormat: target,
        status: attempt.ok
          ? TransformationStatus.SUCCESS
          : TransformationStatus.ERROR,
        inputSize,
        outputSize: attempt.ok ? attempt.size : null,
        durationMs,
        errorCode: attempt.ok ? null : attempt.code,
        createdAt: startedAt,
        completedAt,
        object,
      };
      try {
        await this.history.record(record);
      } catch {
        if (object) await this.store.delete(object.key);
        throw this.reject(
          ctx,
          'history_unavailable',
          'transformation.history_unavailable',
          { inputSize, durationMs },
        );
      }

      if (!attempt.ok) {
        const status = failureStatus(attempt.code);
        this.audit[status >= 500 ? 'error' : 'warn']('transformation.failed', {
          ...this.fields(ctx),
          inputSize,
          durationMs,
          result: 'error',
          errorCode: attempt.code,
          status,
        });
        throw toHttpException(attempt.code);
      }

      this.audit.info('transformation.completed', {
        ...this.fields(ctx),
        inputSize,
        outputSize: attempt.size,
        durationMs,
        result: 'success',
        status: 200,
      });
      handedOver = true;
      return {
        transformationId: ctx.id,
        contentType: attempt.contentType,
        extension: attempt.extension,
        size: attempt.size,
        stream: this.resultStream(workspace),
        ...(object
          ? { storageStatus: object.status as 'pending' | 'failed' }
          : {}),
      };
    } finally {
      if (!handedOver) await workspace.dispose();
    }
  }

  /**
   * Writes an `error` history row for an upload the HTTP layer refused after
   * reading it, then throws the client error of `code`. Without a row (history
   * down) the answer is a 503, like for every other attempt.
   */
  async rejectAttempt(
    attempt: RejectedAttempt,
    code: FailureCode,
  ): Promise<never> {
    const type = attempt.type ?? TransformationType.FILE;
    const target = normalizeFormat(attempt.targetFormat);
    const ctx: Identity = {
      id: randomUUID(),
      cmd: attempt,
      source: normalizeFormat(attempt.sourceFormat),
      target: isFormat(target) ? target : 'unknown',
      type,
    };
    const completedAt = new Date();
    const durationMs = Math.max(
      0,
      completedAt.getTime() - attempt.startedAt.getTime(),
    );
    try {
      await this.history.record({
        id: ctx.id,
        userId: attempt.userId,
        type,
        sourceFormat: ctx.source,
        targetFormat: ctx.target,
        status: TransformationStatus.ERROR,
        inputSize: attempt.inputSize,
        outputSize: null,
        durationMs,
        errorCode: code,
        createdAt: attempt.startedAt,
        completedAt,
      });
    } catch {
      throw this.reject(
        ctx,
        'history_unavailable',
        'transformation.history_unavailable',
        { inputSize: attempt.inputSize, durationMs },
      );
    }
    const status = failureStatus(code);
    this.audit[status >= 500 ? 'error' : 'warn']('transformation.failed', {
      ...this.fields(ctx),
      inputSize: attempt.inputSize,
      durationMs,
      result: 'error',
      errorCode: code,
      status,
    });
    throw toHttpException(code);
  }

  /** Copies the upload to the temp file under the direction's size limit. */
  private async spool(
    ctx: Context,
    converter: Converter,
    workspace: Workspace,
  ): Promise<number> {
    const limit = new ByteLimit(
      converter.limits.maxInputBytes,
      'input_too_large',
    );
    try {
      await pipeline(
        ctx.cmd.input,
        limit,
        createWriteStream(workspace.inputPath, { flags: 'wx', mode: 0o600 }),
      );
    } catch (error) {
      throw this.reject(ctx, classifyInputError(error), undefined, {
        inputSize: limit.bytes,
      });
    }
    if (ctx.cmd.isTruncated?.()) {
      throw this.reject(ctx, 'input_too_large', undefined, {
        inputSize: limit.bytes,
      });
    }
    if (limit.bytes === 0) throw this.reject(ctx, 'invalid_input');
    return limit.bytes;
  }

  /**
   * Runs the converter into the temp output file. Never throws: every outcome
   * is a result or a failure code. On a timeout the converter is aborted and
   * its streams are destroyed, so nothing keeps writing into the temp file.
   */
  private async attempt(
    converter: Converter,
    cmd: ConvertCommand,
    workspace: Workspace,
  ): Promise<AttemptOutcome> {
    const abort = new AbortController();
    const input = createReadStream(workspace.inputPath);
    const output = new ByteLimit(
      converter.limits.maxOutputBytes,
      'output_too_large',
    );
    // Resolves to the write error (or undefined); never rejects.
    const written = pipeline(
      output,
      createWriteStream(workspace.outputPath, { flags: 'wx', mode: 0o600 }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), converter.limits.timeoutMs);
    });
    const work = this.invoke(converter, {
      input,
      output,
      params: cmd.params ?? {},
      signal: abort.signal,
    });

    let first: ConversionOutcome | 'timeout';
    try {
      first = await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }

    if (first === 'timeout') {
      abort.abort();
      input.destroy();
      output.destroy();
      await Promise.all([this.settle(work), this.settle(written)]);
      return { ok: false, code: 'timeout' };
    }

    if (!first.ok) {
      input.destroy();
      output.destroy();
      await written;
      return {
        ok: false,
        code: output.exceeded ? 'output_too_large' : first.code,
      };
    }

    if (!output.writableEnded && !output.destroyed) output.end();
    const writeError = await written;
    input.destroy();
    if (writeError) {
      return {
        ok: false,
        code:
          writeError instanceof ByteLimitError || output.exceeded
            ? 'output_too_large'
            : classifyInputError(writeError) === 'temp_unavailable'
              ? 'temp_unavailable'
              : 'conversion_failed',
      };
    }

    let size: number;
    try {
      size = (await stat(workspace.outputPath)).size;
    } catch {
      return { ok: false, code: 'temp_unavailable' };
    }
    if (
      size === 0 ||
      !isContentType(first.contentType) ||
      !isExtension(first.extension)
    ) {
      // A converter that reports success without a usable result is a failure.
      return { ok: false, code: 'conversion_failed' };
    }
    return {
      ok: true,
      contentType: first.contentType,
      extension: first.extension,
      size,
    };
  }

  /** Calls the converter; anything it throws becomes a safe code. */
  private async invoke(
    converter: Converter,
    request: ConversionRequest,
  ): Promise<ConversionOutcome> {
    try {
      const outcome = await converter.convert(request);
      if (outcome.ok) return outcome;
      return {
        ok: false,
        code: CONVERTER_ERROR_CODES.includes(outcome.code)
          ? outcome.code
          : 'conversion_failed',
      };
    } catch (error) {
      return {
        ok: false,
        code:
          error instanceof ConverterFailure &&
          CONVERTER_ERROR_CODES.includes(error.code)
            ? error.code
            : 'conversion_failed',
      };
    }
  }

  /** Waits for a promise, but not longer than the abort grace period. */
  private async settle(work: Promise<unknown>): Promise<void> {
    await Promise.race([
      work.then(
        () => undefined,
        () => undefined,
      ),
      sleep(ABORT_GRACE_MS, undefined, { ref: false }),
    ]);
  }

  /** `save=true`: keeps a copy for the background write; a failure is recorded, not fatal. */
  private async retain(
    workspace: Workspace,
  ): Promise<{ key: string; status: StorageStatus }> {
    const key = newResultKey();
    try {
      await this.store.retain(key, workspace.outputPath);
      return { key, status: StorageStatus.PENDING };
    } catch {
      return { key, status: StorageStatus.FAILED };
    }
  }

  /** Reads the finished temp file; the job directory goes away when the stream closes. */
  private resultStream(workspace: Workspace): Readable {
    const stream = createReadStream(workspace.outputPath);
    const expire = setTimeout(() => stream.destroy(), RESULT_TTL_MS);
    expire.unref();
    stream.once('close', () => {
      clearTimeout(expire);
      void workspace.dispose();
    });
    return stream;
  }

  private reject(
    ctx: Identity,
    code: FailureCode,
    event = 'transformation.rejected',
    extra: { inputSize?: number; durationMs?: number } = {},
  ): HttpException {
    const status = failureStatus(code);
    this.audit[status >= 500 ? 'error' : 'warn'](event, {
      ...this.fields(ctx),
      ...extra,
      result: 'rejected',
      errorCode: code,
      status,
    });
    return toHttpException(code);
  }

  private fields(ctx: Identity) {
    return {
      requestId: ctx.cmd.requestId,
      transformationId: ctx.id,
      userId: ctx.cmd.userId,
      type: ctx.type,
      sourceFormat: ctx.source,
      targetFormat: ctx.target,
    };
  }
}
