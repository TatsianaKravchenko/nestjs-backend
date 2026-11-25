/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { HttpException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Readable } from 'stream';

import type { TransformationService } from '@/modules/transformations/services/transformation.service';

import type { TextConvertersService } from '../services/text-converters.service';
import { ConvertController } from './convert.controller';

interface Sent {
  status?: number;
  headers: Record<string, unknown>;
  body?: unknown;
}

const reply = () => {
  const sent: Sent = { headers: {} };
  const chain = {
    status: (code: number) => {
      sent.status = code;
      return chain;
    },
    header: (name: string, value: unknown) => {
      sent.headers[name] = value;
      return chain;
    },
    send: (body: unknown) => {
      sent.body = body;
      return chain;
    },
  };
  return { reply: chain as unknown as FastifyReply, sent };
};

type Field = [name: string, value: string];

interface Options {
  /** Text fields; they are placed `fieldsAfterFile` or before the file. */
  fields?: Field[];
  fieldsAfterFile?: boolean;
  /** Parts after everything else, e.g. an unknown field. */
  extra?: Field[];
  filename?: string;
  mimetype?: string;
  content?: string;
  /** The parser cut the file at the limit. */
  truncated?: boolean;
}

const CONTENT = 'a,b\n1,2\n';

const setup = (options: Options = {}) => {
  const resultStream = Readable.from(['{}']);
  const convert = jest.fn().mockResolvedValue({
    transformationId: 'id-1',
    contentType: 'application/json',
    extension: 'json',
    size: 2,
    stream: resultStream,
    saveStatus: 'pending',
  });
  const rejectAttempt = jest
    .fn()
    .mockRejectedValue(new HttpException('bad request', 400));

  const fields = (options.fields ?? [['targetFormat', 'json']]).map(
    ([fieldname, value]) => ({ type: 'field', fieldname, value }),
  );
  const file = Object.assign(Readable.from([Buffer.from(CONTENT)]), {
    truncated: options.truncated ?? false,
  });
  const filePart = {
    type: 'file',
    fieldname: 'file',
    filename: options.filename ?? 'a.csv',
    mimetype: options.mimetype ?? 'text/csv',
    file,
  };
  const extra = (options.extra ?? []).map(([fieldname, value]) => ({
    type: 'field',
    fieldname,
    value,
  }));
  const ordered = options.fieldsAfterFile
    ? [filePart, ...fields, ...extra]
    : [...fields, filePart, ...extra];
  const parts = ordered[Symbol.iterator]();

  const request = {
    id: 'req-1',
    user: { id: 'user-1' },
    isMultipart: () => true,
    parts: () => ({ next: () => Promise.resolve(parts.next()) }),
  };
  const controller = new ConvertController(
    { convert, rejectAttempt } as unknown as TransformationService,
    {
      maxInputBytes: 100,
      formats: () => [{ source: 'csv', target: ['json'] }],
    } as unknown as TextConvertersService,
  );
  return { controller, request, convert, rejectAttempt, resultStream };
};

const statusOf = async (promise: Promise<unknown>): Promise<number> => {
  try {
    await promise;
  } catch (error) {
    return (error as HttpException).getStatus();
  }
  return 200;
};

const readAll = async (stream: Readable): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

describe('ConvertController', () => {
  it('lists the formats', () => {
    expect(setup().controller.formats()).toEqual([
      { source: 'csv', target: ['json'] },
    ]);
  });

  it('converts and answers with the file headers', async () => {
    const { controller, request, convert, resultStream } = setup({
      fields: [
        ['targetFormat', 'JSON'],
        ['save', 'true'],
      ],
    });
    const { reply: res, sent } = reply();

    await controller.convert(request as never, res);

    expect(convert).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-1',
        userId: 'user-1',
        sourceFormat: 'csv',
        targetFormat: 'JSON',
        save: true,
      }),
    );
    const input = (convert.mock.calls[0] as [{ input: Readable }])[0].input;
    expect(await readAll(input)).toBe(CONTENT);
    expect(sent.status).toBe(200);
    expect(sent.headers).toMatchObject({
      'content-type': 'application/json',
      'content-length': 2,
      'content-disposition': 'attachment; filename="converted.json"',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'x-transformation-id': 'id-1',
      'x-save-status': 'pending',
    });
    expect(sent.body).toBe(resultStream);
  });

  it('does not save by default', async () => {
    const { controller, request, convert } = setup();
    await controller.convert(request as never, reply().reply);
    expect(convert).toHaveBeenCalledWith(
      expect.objectContaining({ save: false }),
    );
  });

  it.each([
    ['before the file', false],
    ['after the file', true],
  ])('accepts targetFormat and save %s', async (_label, fieldsAfterFile) => {
    const { controller, request, convert, rejectAttempt } = setup({
      fields: [
        ['save', 'true'],
        ['targetFormat', 'yaml'],
      ],
      fieldsAfterFile,
    });

    await controller.convert(request as never, reply().reply);

    expect(rejectAttempt).not.toHaveBeenCalled();
    expect(convert).toHaveBeenCalledWith(
      expect.objectContaining({ targetFormat: 'yaml', save: true }),
    );
  });

  it.each([
    ['a missing target', { fields: [] }, 400],
    [
      'an invalid save value',
      {
        fields: [
          ['targetFormat', 'json'],
          ['save', 'x'],
        ],
      },
      400,
    ],
    [
      'the target equal to the source',
      { fields: [['targetFormat', ' CSV ']] },
      400,
    ],
    [
      'an unsupported extension',
      { filename: 'a.txt', mimetype: 'text/plain' },
      415,
    ],
    ['a wrong MIME type', { mimetype: 'image/png' }, 415],
  ] as [string, Options, number][])(
    'rejects %s before converting',
    async (_label, options, status) => {
      const { controller, request, convert, rejectAttempt } = setup(options);

      expect(
        await statusOf(controller.convert(request as never, reply().reply)),
      ).toBe(status);
      expect(convert).not.toHaveBeenCalled();
      expect(rejectAttempt).not.toHaveBeenCalled();
    },
  );

  it('answers 413 for a file over the limit, without converting', async () => {
    const { controller, request, convert } = setup({ truncated: true });

    expect(
      await statusOf(controller.convert(request as never, reply().reply)),
    ).toBe(413);
    expect(convert).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown field after the file', { extra: [['other', '1']] }],
    [
      'an unknown field before the file',
      {
        fields: [
          ['targetFormat', 'json'],
          ['other', '1'],
        ],
      },
    ],
    [
      'a repeated field',
      {
        fields: [['targetFormat', 'json']],
        extra: [['targetFormat', 'xml']],
      },
    ],
  ] as [string, Options][])(
    'records an error and answers 400 for %s; nothing is converted',
    async (_label, options) => {
      const { controller, request, convert, rejectAttempt } = setup(options);
      const { reply: res, sent } = reply();

      expect(await statusOf(controller.convert(request as never, res))).toBe(
        400,
      );

      expect(convert).not.toHaveBeenCalled();
      expect(sent.status).toBeUndefined();
      expect(rejectAttempt).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'req-1',
          userId: 'user-1',
          sourceFormat: 'csv',
          targetFormat: 'json',
          inputSize: Buffer.byteLength(CONTENT),
          startedAt: expect.any(Date),
        }),
        'invalid_input',
      );
    },
  );

  it('records an unknown target as an empty string', async () => {
    const { controller, request, rejectAttempt } = setup({
      fields: [],
      extra: [['other', '1']],
    });

    await statusOf(controller.convert(request as never, reply().reply));

    expect(rejectAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ targetFormat: '' }),
      'invalid_input',
    );
  });

  it('does not record a violation when the source is unsupported', async () => {
    const { controller, request, rejectAttempt } = setup({
      filename: 'a.txt',
      mimetype: 'text/plain',
      extra: [['other', '1']],
    });

    expect(
      await statusOf(controller.convert(request as never, reply().reply)),
    ).toBe(415);
    expect(rejectAttempt).not.toHaveBeenCalled();
  });

  it('passes a pipeline failure through unchanged', async () => {
    const { controller, request, convert } = setup();
    const failure = new HttpException('too big', 413);
    convert.mockRejectedValue(failure);

    await expect(
      controller.convert(request as never, reply().reply),
    ).rejects.toBe(failure);
  });
});
