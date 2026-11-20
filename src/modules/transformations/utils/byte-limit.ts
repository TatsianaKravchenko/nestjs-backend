import { Transform, type TransformCallback } from 'stream';

export type ByteLimitCode = 'input_too_large' | 'output_too_large';

export class ByteLimitError extends Error {
  constructor(readonly code: ByteLimitCode) {
    super(code);
    this.name = 'ByteLimitError';
  }
}

/**
 * Passes bytes through and fails the stream with `ByteLimitError` as soon as
 * more than `max` bytes went by. It is the hard size limit that remains even
 * when a library streams: nothing past the limit reaches the next stage.
 */
export class ByteLimit extends Transform {
  bytes = 0;
  exceeded = false;

  constructor(
    private readonly max: number,
    private readonly code: ByteLimitCode,
  ) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.bytes += chunk.length;
    if (this.bytes > this.max) {
      this.exceeded = true;
      callback(new ByteLimitError(this.code));
      return;
    }
    callback(null, chunk);
  }
}
