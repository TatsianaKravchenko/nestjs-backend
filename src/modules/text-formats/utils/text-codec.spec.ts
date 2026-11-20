import { Readable } from 'stream';

import { ConverterFailure } from '@/modules/transformations/services/converter';

import { decodeText, readInput } from './text-codec';

describe('text-codec', () => {
  it('reads a whole stream', async () => {
    const data = await readInput(
      Readable.from([Buffer.from('a'), Buffer.from('b')]),
    );
    expect(data.toString()).toBe('ab');
  });

  it('decodes UTF-8 and strips an initial BOM', () => {
    expect(decodeText(Buffer.from('\uFEFFпривет'))).toBe('привет');
  });

  it.each([
    ['invalid bytes', Buffer.from([0x61, 0xff, 0xfe])],
    ['UTF-16 BOM', Buffer.from([0xff, 0xfe, 0x61, 0x00])],
    ['BOM in the middle', Buffer.from('a\uFEFFb')],
    ['whitespace only', Buffer.from(' \n\t')],
    ['empty', Buffer.alloc(0)],
  ])('rejects %s', (_label, data) => {
    expect(() => decodeText(data)).toThrow(ConverterFailure);
  });
});
