import type { Readable, Writable } from 'stream';

import type { TransformationType } from '../entities/transformation.entity';

/**
 * Safe failure codes a converter may report. They are stored in the history
 * and mapped to HTTP statuses by the service; a library message never leaves
 * the converter.
 */
export const CONVERTER_ERROR_CODES = [
  /** Corrupt or empty input, invalid parameters. */
  'invalid_input',
  'input_too_large',
  'output_too_large',
  'unsupported_format',
  /** A required dependency is down (reported as 503). */
  'dependency_unavailable',
  'timeout',
  /** The library could not process the content. */
  'conversion_failed',
] as const;
export type ConverterErrorCode = (typeof CONVERTER_ERROR_CODES)[number];

export type ConverterParams = Readonly<Record<string, unknown>>;

/** Limits of one direction; enforced by the service, not by the converter. */
export interface ConverterLimits {
  maxInputBytes: number;
  maxOutputBytes: number;
  timeoutMs: number;
}

export interface ConversionRequest {
  /** The input file. The converter must not read it after it returned. */
  input: Readable;
  /** The result. Capped at `maxOutputBytes`; the service ends it when the converter returns. */
  output: Writable;
  /** Parameters already validated by the caller. */
  params: ConverterParams;
  /** Aborted on timeout: stop work and release the library. */
  signal: AbortSignal;
}

export type ConversionOutcome =
  | { ok: true; contentType: string; extension: string; size: number }
  | { ok: false; code: ConverterErrorCode };

/** A converter may throw this instead of returning `{ ok: false }`. */
export class ConverterFailure extends Error {
  constructor(readonly code: ConverterErrorCode) {
    super(code);
    this.name = 'ConverterFailure';
  }
}

/**
 * One direction (`source -> target`) of one library. A converter knows nothing
 * about HTTP, JWT or the history: it reads a stream, writes a stream and
 * reports the actual content type, extension and size (or a safe code).
 * Register it with `ConverterRegistry.register` on module init.
 */
export interface Converter {
  readonly type: TransformationType;
  readonly source: string;
  readonly target: string;
  readonly limits: ConverterLimits;
  convert(request: ConversionRequest): Promise<ConversionOutcome>;
}
