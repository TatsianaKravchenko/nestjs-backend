import { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';

import { ByteLimit, ByteLimitError } from './byte-limit';

const sink = () => {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  return { stream, bytes: () => Buffer.concat(chunks).length };
};

describe('ByteLimit', () => {
  it('passes everything up to the limit', async () => {
    const limit = new ByteLimit(6, 'input_too_large');
    const out = sink();

    await pipeline(
      Readable.from([Buffer.from('abc'), Buffer.from('def')]),
      limit,
      out.stream,
    );

    expect(out.bytes()).toBe(6);
    expect(limit.bytes).toBe(6);
    expect(limit.exceeded).toBe(false);
  });

  it('fails with its code as soon as the limit is passed, and nothing past it goes on', async () => {
    const limit = new ByteLimit(4, 'output_too_large');
    const out = sink();

    const error: unknown = await pipeline(
      Readable.from([
        Buffer.from('abc'),
        Buffer.from('def'),
        Buffer.from('ghi'),
      ]),
      limit,
      out.stream,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ByteLimitError);
    expect((error as ByteLimitError).code).toBe('output_too_large');
    expect(limit.exceeded).toBe(true);
    expect(out.bytes()).toBeLessThanOrEqual(3);
  });
});
