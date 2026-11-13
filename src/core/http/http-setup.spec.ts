import { Body, Controller, Post, Req } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { FastifyRequest } from 'fastify';

import { hasDuplicateKeys, setupHttp } from './http-setup';

describe('hasDuplicateKeys', () => {
  it.each([
    ['{"a":1,"a":2}'],
    ['{"a":{"b":1,"b":2}}'],
    ['{"x":[{"a":1,"a":2}]}'],
    ['{"a":1,"b":{"c":1},"a":3}'],
    ['{"a":1,"\\u0061":2}'],
    ['{"a\\"b":1,"a\\"b":2}'],
  ])('detects a repeated key in %s', (json) => {
    expect(hasDuplicateKeys(json)).toBe(true);
  });

  it.each([
    ['{"a":1,"b":2}'],
    ['{"a":{"x":1},"b":{"x":2}}'],
    ['[{"a":1},{"a":2}]'],
    ['{"a":[1,2,{"a":3}]}'],
    ['{"a":"{\\"a\\":1,\\"a\\":2}","b":"x,y"}'],
    ['{"a":"}, {","b":"\\"a\\":"}'],
    ['{}'],
    ['[]'],
    ['"a"'],
    ['{"a":null,"b":true,"c":1.5e3}'],
  ])('accepts %s', (json) => {
    expect(hasDuplicateKeys(json)).toBe(false);
  });
});

@Controller()
class EchoController {
  @Post('echo')
  echo(@Body() body: unknown) {
    return { body };
  }

  @Post('parts')
  async parts(@Req() request: FastifyRequest) {
    const types: string[] = [];
    for await (const part of request.parts()) {
      types.push(part.type);
      if (part.type === 'file') await part.toBuffer();
    }
    return { types };
  }

  @Post('file')
  async file(@Req() request: FastifyRequest) {
    const part = await request.file();
    return {
      multipart: request.isMultipart(),
      field: part?.fieldname,
      size: part ? (await part.toBuffer()).length : 0,
    };
  }
}

describe('setupHttp', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EchoController],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await setupHttp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(() => app.close());

  const post = (url: string, payload: string | Buffer, contentType: string) =>
    app.inject({
      method: 'POST',
      url,
      payload,
      headers: { 'content-type': contentType },
    });

  it('passes a valid JSON body', async () => {
    const res = await post('/echo', '{"a":1,"b":{"a":2}}', 'application/json');

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ body: { a: 1, b: { a: 2 } } });
  });

  it('answers 400 for a repeated key instead of keeping the last one', async () => {
    const res = await post(
      '/echo',
      '{"displayName":"a","displayName":"b"}',
      'application/json',
    );

    expect(res.statusCode).toBe(400);
  });

  it('keeps the default errors for malformed or empty JSON (400)', async () => {
    expect((await post('/echo', '{"a":', 'application/json')).statusCode).toBe(
      400,
    );
    expect((await post('/echo', '', 'application/json')).statusCode).toBe(400);
  });

  it('still refuses prototype poisoning', async () => {
    const res = await post(
      '/echo',
      '{"__proto__":{"admin":true}}',
      'application/json',
    );

    expect(res.statusCode).toBe(400);
  });

  it('parses urlencoded bodies', async () => {
    const res = await post(
      '/echo',
      'a=1&b=two',
      'application/x-www-form-urlencoded',
    );

    expect(res.json()).toEqual({ body: { a: '1', b: 'two' } });
  });

  describe('multipart', () => {
    const boundary = 'xBOUNDARYx';
    const form = (parts: string[]) =>
      Buffer.from(parts.join('') + `--${boundary}--\r\n`);
    const file = (name: string, data: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n${data}\r\n`;
    const text = (name: string, data: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${data}\r\n`;
    const type = `multipart/form-data; boundary=${boundary}`;

    it('is registered: one file field is read', async () => {
      const res = await post('/file', form([file('file', 'hello')]), type);

      expect(res.json()).toEqual({ multipart: true, field: 'file', size: 5 });
    });

    it('refuses a text field when the parts are read (fields limit is 0)', async () => {
      const res = await post(
        '/parts',
        form([text('note', 'x'), file('file', 'hello')]),
        type,
      );

      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.json<{ message: string }>().message).toMatch(/fields limit/);
    });

    it('refuses a file over 5 MiB', async () => {
      const res = await post(
        '/file',
        form([file('file', 'a'.repeat(5 * 1024 * 1024 + 1))]),
        type,
      );

      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });
  });
});
