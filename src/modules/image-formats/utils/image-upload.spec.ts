/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import type { HttpException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Readable } from 'stream';

import { detectImageSource, readImageUpload } from './image-upload';

describe('detectImageSource', () => {
  it.each([
    ['a.png', 'image/png', 'png'],
    ['A.PNG', 'application/octet-stream', 'png'],
    ['a.jpg', 'image/jpeg', 'jpeg'],
    ['a.jpeg', 'image/jpeg', 'jpeg'],
    ['a.b.jpeg', 'image/pjpeg', 'jpeg'],
    ['a.svg', 'image/svg+xml', 'svg'],
    ['a.svg', 'image/svg+xml; charset=utf-8', 'svg'],
    ['a.svg', 'text/xml', 'svg'],
  ])('%s (%s) is %s', (name, mime, expected) => {
    expect(detectImageSource(name, mime)).toBe(expected);
  });

  it.each([
    ['a.gif', 'image/gif'],
    ['a.webp', 'image/webp'],
    ['a.txt', 'text/plain'],
    ['noextension', 'image/png'],
    ['a.', 'image/png'],
    ['a.png', 'image/jpeg'],
    ['a.svg', 'image/png'],
    ['a.png', 'text/html'],
  ])('rejects %s (%s) with 415', (name, mime) => {
    try {
      detectImageSource(name, mime);
      throw new Error('expected a failure');
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(415);
    }
  });
});

describe('readImageUpload', () => {
  const parts = (items: unknown[]) => {
    const iterator = items[Symbol.iterator]();
    return { next: () => Promise.resolve(iterator.next()) };
  };

  it('allows targetFormat, options, save and file, with room for the options JSON', async () => {
    const request = {
      isMultipart: () => true,
      parts: jest.fn().mockReturnValue(
        parts([
          { type: 'field', fieldname: 'targetFormat', value: 'png' },
          { type: 'field', fieldname: 'options', value: '{"width":9}' },
          { type: 'field', fieldname: 'save', value: 'true' },
          {
            type: 'file',
            fieldname: 'file',
            filename: 'a.svg',
            mimetype: 'image/svg+xml',
            file: Object.assign(Readable.from([Buffer.from('<svg/>')]), {
              truncated: false,
            }),
          },
        ]),
      ),
    } as unknown as FastifyRequest;

    const upload = await readImageUpload(request, 100);

    expect(upload.violation).toBe(false);
    expect(upload.fields).toEqual({
      targetFormat: 'png',
      options: '{"width":9}',
      save: 'true',
    });
    expect(upload.file.data.toString()).toBe('<svg/>');
    expect(request.parts).toHaveBeenCalledWith({
      limits: expect.objectContaining({ fileSize: 101, fieldSize: 512 }),
    });
  });

  it('flags a field the endpoint does not know', async () => {
    const request = {
      isMultipart: () => true,
      parts: () =>
        parts([
          { type: 'field', fieldname: 'format', value: 'png' },
          {
            type: 'file',
            fieldname: 'file',
            filename: 'a.png',
            mimetype: 'image/png',
            file: Object.assign(Readable.from([Buffer.from('x')]), {
              truncated: false,
            }),
          },
        ]),
    } as unknown as FastifyRequest;

    expect((await readImageUpload(request, 100)).violation).toBe(true);
  });
});
