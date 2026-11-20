/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { HttpException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Readable } from 'stream';

import { detectSource, readUpload } from './convert-upload';

describe('detectSource', () => {
  it.each([
    ['a.csv', 'text/csv', 'csv'],
    ['A.JSON', 'application/json', 'json'],
    ['a.xml', 'text/xml', 'xml'],
    ['a.yaml', 'application/x-yaml', 'yaml'],
    ['a.yml', 'text/plain', 'yaml'],
    ['a.b.csv', 'application/octet-stream', 'csv'],
  ])('%s (%s) is %s', (name, mime, expected) => {
    expect(detectSource(name, mime)).toBe(expected);
  });

  it.each([
    ['a.txt', 'text/plain'],
    ['noextension', 'text/csv'],
    ['a.', 'text/csv'],
    ['a.csv', 'application/json'],
    ['a.json', 'image/png'],
  ])('rejects %s (%s) with 415', (name, mime) => {
    try {
      detectSource(name, mime);
      throw new Error('expected a failure');
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(415);
    }
  });
});

type Part =
  | {
      type: 'field';
      fieldname: string;
      value: unknown;
      valueTruncated?: boolean;
    }
  | {
      type: 'file';
      fieldname: string;
      file: Readable;
      filename: string;
      mimetype: string;
    };

/** An async iterator over the parts, like `request.parts()`. */
const iterate = (parts: Part[]) => {
  const items = parts[Symbol.iterator]();
  return { next: () => Promise.resolve(items.next()) };
};

const request = (parts: Part[], multipart = true) =>
  ({
    isMultipart: () => multipart,
    parts: jest.fn().mockReturnValue(iterate(parts)),
  }) as unknown as FastifyRequest;

const file = (
  name = 'file',
  content: string | Buffer = 'a,b\n1,2\n',
): Part => ({
  type: 'file',
  fieldname: name,
  file: Readable.from([Buffer.from(content)]),
  filename: 'a.csv',
  mimetype: 'text/csv',
});
const field = (
  fieldname: string,
  value: unknown = 'json',
  truncated = false,
): Part => ({
  type: 'field',
  fieldname,
  value,
  valueTruncated: truncated,
});

/** A file part backed by a custom stream. */
const withFile = (stream: Readable): Part => ({
  type: 'file',
  fieldname: 'file',
  file: stream,
  filename: 'a.csv',
  mimetype: 'text/csv',
});

const statusOf = async (promise: Promise<unknown>): Promise<number> => {
  try {
    await promise;
  } catch (error) {
    return (error as HttpException).getStatus();
  }
  return 200;
};

describe('readUpload', () => {
  it('buffers the file and applies per-request limits', async () => {
    const req = request([field('targetFormat'), field('save', 'true'), file()]);
    const upload = await readUpload(req, 100);

    expect(upload.fields).toEqual({ targetFormat: 'json', save: 'true' });
    expect(upload.file).toMatchObject({
      filename: 'a.csv',
      mimetype: 'text/csv',
      truncated: false,
    });
    expect(upload.file.data.toString()).toBe('a,b\n1,2\n');
    expect(upload.violation).toBe(false);
    expect(req.parts).toHaveBeenCalledWith({
      limits: expect.objectContaining({ fileSize: 101 }),
    });
  });

  it.each([
    [
      'file first',
      () => [file(), field('targetFormat'), field('save', 'false')],
    ],
    [
      'file in the middle',
      () => [field('save', 'true'), file(), field('targetFormat')],
    ],
    ['file last', () => [field('targetFormat'), field('save', 'true'), file()]],
    ['file only', () => [file()]],
  ])('accepts the fields in any order: %s', async (_label, parts) => {
    const upload = await readUpload(request(parts()), 100);
    expect(upload.violation).toBe(false);
    expect(upload.file.data.toString()).toBe('a,b\n1,2\n');
    expect(Object.keys(upload.fields).sort()).toEqual(
      parts()
        .filter((part) => part.type === 'field')
        .map((part) => part.fieldname)
        .sort(),
    );
  });

  it.each([
    [
      'an unknown field after the file',
      [field('targetFormat'), file(), field('extra')],
    ],
    [
      'an unknown field before the file',
      [field('extra'), field('targetFormat'), file()],
    ],
    [
      'a repeated field',
      [file(), field('targetFormat'), field('targetFormat', 'xml')],
    ],
    ['a non-string field value', [field('targetFormat', 5), file()]],
    ['a truncated field value', [field('targetFormat', 'x', true), file()]],
    ['a second file', [field('targetFormat'), file(), file()]],
    ['a file under the wrong name', [file(), file('upload')]],
  ])(
    'flags %s as a violation but still returns the first file',
    async (_label, parts) => {
      const upload = await readUpload(request(parts), 100);
      expect(upload.violation).toBe(true);
      expect(upload.file.data.length).toBeGreaterThan(0);
    },
  );

  it('flags a multipart limit error as a violation', async () => {
    const parts = {
      next: jest
        .fn()
        .mockResolvedValueOnce({ done: false, value: file() })
        .mockRejectedValueOnce(
          Object.assign(new Error('x'), { code: 'FST_PARTS_LIMIT' }),
        ),
    };
    const req = {
      isMultipart: () => true,
      parts: () => parts,
    } as unknown as FastifyRequest;

    const upload = await readUpload(req, 100);

    expect(upload.violation).toBe(true);
    expect(upload.file.data.length).toBeGreaterThan(0);
  });

  it('reports an oversized file as truncated and stops reading', async () => {
    const tooLarge = new Readable({
      read() {
        this.push(Buffer.from('abc'));
        this.destroy(
          Object.assign(new Error('big'), { code: 'FST_REQ_FILE_TOO_LARGE' }),
        );
      },
    });
    const parts = [withFile(tooLarge), field('targetFormat')] as Part[];

    const upload = await readUpload(request(parts), 2);

    expect(upload.file.truncated).toBe(true);
    expect(upload.fields).toEqual({});
  });

  it('reports a file the parser cut as truncated', async () => {
    const cut = Readable.from([Buffer.from('abc')]) as Readable & {
      truncated: boolean;
    };
    cut.truncated = true;
    const parts = [withFile(cut)];
    expect((await readUpload(request(parts), 2)).file.truncated).toBe(true);
  });

  it('answers 415 for a non-multipart request', async () => {
    expect(await statusOf(readUpload(request([], false), 100))).toBe(415);
  });

  it.each([
    ['no file', [field('targetFormat')]],
    ['only unexpected parts', [field('targetFormat'), file('upload')]],
  ])('answers 400 for %s', async (_label, parts) => {
    expect(await statusOf(readUpload(request(parts), 100))).toBe(400);
  });

  it('answers 400 for a malformed body', async () => {
    const req = {
      isMultipart: () => true,
      parts: () => ({
        next: () =>
          Promise.reject(Object.assign(new Error('x'), { code: 'FST_ERR' })),
      }),
    } as unknown as FastifyRequest;
    expect(await statusOf(readUpload(req, 100))).toBe(400);
  });

  it('answers 400 when the file stream breaks', async () => {
    const broken = new Readable({
      read() {
        this.destroy(new Error('socket closed'));
      },
    });
    const parts = [withFile(broken)];
    expect(await statusOf(readUpload(request(parts), 100))).toBe(400);
  });
});
