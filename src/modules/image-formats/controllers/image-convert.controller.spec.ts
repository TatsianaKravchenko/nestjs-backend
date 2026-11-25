import { HttpException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Readable } from 'stream';

import type { TransformationService } from '@/modules/transformations/services/transformation.service';

import type { ImageConvertersService } from '../services/image-converters.service';
import { ImageConvertController } from './image-convert.controller';

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
  fields?: Field[];
  fieldsAfterFile?: boolean;
  extra?: Field[];
  filename?: string;
  mimetype?: string;
  truncated?: boolean;
  /** Which pairs the registry knows. */
  supported?: boolean;
}

const CONTENT = 'image-bytes';

const setup = (options: Options = {}) => {
  const resultStream = Readable.from(['x']);
  const convert = jest.fn().mockResolvedValue({
    transformationId: 'id-1',
    contentType: 'image/jpeg',
    extension: 'jpeg',
    size: 1,
    stream: resultStream,
    saveStatus: 'not_requested',
  });
  const rejectAttempt = jest
    .fn()
    .mockRejectedValue(new HttpException('bad request', 400));
  const isSupported = jest.fn().mockReturnValue(options.supported ?? true);

  const fields = (options.fields ?? [['targetFormat', 'jpeg']]).map(
    ([fieldname, value]) => ({ type: 'field', fieldname, value }),
  );
  const filePart = {
    type: 'file',
    fieldname: 'file',
    filename: options.filename ?? 'a.png',
    mimetype: options.mimetype ?? 'image/png',
    file: Object.assign(Readable.from([Buffer.from(CONTENT)]), {
      truncated: options.truncated ?? false,
    }),
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
  const controller = new ImageConvertController(
    { convert, rejectAttempt } as unknown as TransformationService,
    {
      maxInputBytes: 100,
      isSupported,
      formats: () => [{ source: 'png', target: ['jpeg'] }],
    } as unknown as ImageConvertersService,
  );
  return {
    controller,
    request,
    convert,
    rejectAttempt,
    isSupported,
    resultStream,
  };
};

const statusOf = async (promise: Promise<unknown>): Promise<number> => {
  try {
    await promise;
  } catch (error) {
    return (error as HttpException).getStatus();
  }
  return 200;
};

describe('ImageConvertController', () => {
  it('lists the formats', () => {
    expect(setup().controller.formats()).toEqual([
      { source: 'png', target: ['jpeg'] },
    ]);
  });

  it('converts and answers with the image headers', async () => {
    const { controller, request, convert, resultStream } = setup({
      fields: [
        ['targetFormat', ' JPEG '],
        ['options', '{"quality":50}'],
        ['save', 'true'],
      ],
    });
    const { reply: res, sent } = reply();

    await controller.convert(request as never, res);

    expect(convert).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-1',
        userId: 'user-1',
        sourceFormat: 'png',
        targetFormat: 'jpeg',
        params: { quality: 50, background: '#ffffff' },
        save: true,
      }),
    );
    expect(sent.status).toBe(200);
    expect(sent.headers).toMatchObject({
      'content-type': 'image/jpeg',
      'content-length': 1,
      'content-disposition': 'attachment; filename="converted.jpeg"',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'x-transformation-id': 'id-1',
      'x-save-status': 'not_requested',
    });
    expect(sent.body).toBe(resultStream);
  });

  it('applies the defaults and does not save by default', async () => {
    const { controller, request, convert } = setup();
    await controller.convert(request as never, reply().reply);
    expect(convert).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { quality: 85, background: '#ffffff' },
        save: false,
      }),
    );
  });

  it('accepts the fields after the file', async () => {
    const { controller, request, convert } = setup({
      fields: [
        ['save', 'true'],
        ['targetFormat', 'jpeg'],
      ],
      fieldsAfterFile: true,
    });
    await controller.convert(request as never, reply().reply);
    expect(convert).toHaveBeenCalledWith(
      expect.objectContaining({ targetFormat: 'jpeg', save: true }),
    );
  });

  it('passes the svg size options on', async () => {
    const { controller, request, convert } = setup({
      filename: 'a.svg',
      mimetype: 'image/svg+xml',
      fields: [
        ['targetFormat', 'png'],
        ['options', '{"width":200}'],
      ],
    });
    await controller.convert(request as never, reply().reply);
    expect(convert).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceFormat: 'svg',
        targetFormat: 'png',
        params: { width: 200 },
      }),
    );
  });

  it.each([
    ['a missing target', { fields: [] }, 400],
    [
      'an invalid save value',
      {
        fields: [
          ['targetFormat', 'jpeg'],
          ['save', 'yes'],
        ],
      },
      400,
    ],
    [
      'options that are not json',
      {
        fields: [
          ['targetFormat', 'jpeg'],
          ['options', 'x'],
        ],
      },
      400,
    ],
    [
      'an unknown option',
      {
        fields: [
          ['targetFormat', 'jpeg'],
          ['options', '{"sharpen":1}'],
        ],
      },
      400,
    ],
    [
      'quality for a png target',
      {
        filename: 'a.jpg',
        mimetype: 'image/jpeg',
        fields: [
          ['targetFormat', 'png'],
          ['options', '{"quality":50}'],
        ],
      },
      400,
    ],
    [
      'width for a raster source',
      {
        fields: [
          ['targetFormat', 'jpeg'],
          ['options', '{"width":50}'],
        ],
      },
      400,
    ],
    [
      'options longer than allowed',
      {
        fields: [
          ['targetFormat', 'jpeg'],
          ['options', `{"quality":1,"x":"${'a'.repeat(600)}"}`],
        ],
      },
      400,
    ],
    [
      'an unsupported extension',
      { filename: 'a.gif', mimetype: 'image/gif' },
      415,
    ],
    ['a wrong MIME type', { mimetype: 'text/plain' }, 415],
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

  it('leaves an unsupported pair to the pipeline (415), without option checks', async () => {
    const { controller, request, convert } = setup({
      supported: false,
      fields: [
        ['targetFormat', 'svg'],
        ['options', '{"anything":true}'],
      ],
    });
    convert.mockRejectedValue(new HttpException('unsupported', 415));

    expect(
      await statusOf(controller.convert(request as never, reply().reply)),
    ).toBe(415);
    expect(convert).toHaveBeenCalledWith(
      expect.objectContaining({ targetFormat: 'svg', params: {} }),
    );
  });

  it('answers 413 for a file over the limit, without converting', async () => {
    const { controller, request, convert } = setup({ truncated: true });
    expect(
      await statusOf(controller.convert(request as never, reply().reply)),
    ).toBe(413);
    expect(convert).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown field', { extra: [['other', '1']] }],
    [
      'a repeated field',
      { fields: [['targetFormat', 'jpeg']], extra: [['targetFormat', 'png']] },
    ],
  ] as [string, Options][])(
    'records an image error and answers 400 for %s',
    async (_label, options) => {
      const { controller, request, convert, rejectAttempt } = setup(options);

      expect(
        await statusOf(controller.convert(request as never, reply().reply)),
      ).toBe(400);
      expect(convert).not.toHaveBeenCalled();
      expect(rejectAttempt).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceFormat: 'png',
          targetFormat: 'jpeg',
          inputSize: Buffer.byteLength(CONTENT),
          type: 'image',
        }),
        'invalid_input',
      );
    },
  );

  it('passes a pipeline failure through unchanged', async () => {
    const { controller, request, convert } = setup();
    const failure = new HttpException('timeout', 504);
    convert.mockRejectedValue(failure);

    await expect(
      controller.convert(request as never, reply().reply),
    ).rejects.toBe(failure);
  });
});
