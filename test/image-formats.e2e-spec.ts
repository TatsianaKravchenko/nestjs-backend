/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtemp, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { DataSource } from 'typeorm';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { AppModule } from '../src/core/app/app.module';
import { ConfigService } from '../src/core/config/config.service';
import { setupHttp } from '../src/core/http/http-setup';
import { ProblemDetailsExceptionFilter } from '../src/modules/auth/errors/problem-details-exception.filter';
import { MailService } from '../src/modules/auth/services/mail.service';
import { TokenService } from '../src/modules/auth/services/token.service';

const PREFIX = 'image-formats-spec';
const DOMAIN = '@example.test';
/** Small, so that a noisy image is "too large" while a flat 4096-wide one is not. */
const MAX_RASTER = 64 * 1024;
let counter = 0;
const unique = (label: string) =>
  `${PREFIX}-${label}-${Date.now()}-${counter++}`;

type TestApp = NestFastifyApplication & { db: DataSource };
let transactionalReady = false;

type Part =
  | { field: string; value: string }
  | { file: Buffer | string; filename: string; mime: string; name?: string };

function multipart(parts: Part[]) {
  const boundary = `----imageformats${Date.now()}${counter++}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if ('field' in part) {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.field}"\r\n\r\n${part.value}\r\n`,
        ),
      );
    } else {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name ?? 'file'}"; filename="${part.filename}"\r\nContent-Type: ${part.mime}\r\n\r\n`,
        ),
        Buffer.from(part.file),
        Buffer.from('\r\n'),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

const solid = (
  width: number,
  height: number,
  format: 'png' | 'jpeg',
  alpha = 1,
) =>
  sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha },
    },
  })
    .toFormat(format)
    .toBuffer();

const noise = (side: number) =>
  sharp({
    create: {
      width: side,
      height: side,
      channels: 3,
      background: '#000000',
      noise: { type: 'gaussian', mean: 128, sigma: 80 },
    },
  })
    .png()
    .toBuffer();

const png = (data: Buffer): Part => ({
  file: data,
  filename: 'private-name.png',
  mime: 'image/png',
});
const jpeg = (data: Buffer): Part => ({
  file: data,
  filename: 'private-name.jpg',
  mime: 'image/jpeg',
});
const svgFile = (text: string): Part => ({
  file: text,
  filename: 'private-name.svg',
  mime: 'image/svg+xml',
});
const SVG = (
  attributes: string,
  body = '<rect width="40" height="20" fill="red"/>',
) => `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`;

const dims = async (data: Buffer) => {
  const meta = await sharp(data).metadata();
  return [meta.format, meta.width, meta.height];
};

describe('Image transformation (e2e)', () => {
  let app: TestApp;
  let tempDir: string;
  let storageDir: string;
  let convertRole: string;
  let plainRole: string;

  const env = (): Record<string, string> => ({
    REGISTRATION_CONFIRMATION_ENABLED: 'false',
    API_PUBLIC_URL: 'https://api.test',
    STORAGE_CLEANUP_WORKER_ENABLED: 'false',
    DELETION_WORKER_ENABLED: 'false',
    TRANSFORM_TEMP_DIR: tempDir,
    TRANSFORM_STORAGE_DIR: storageDir,
    PHOTO_STORAGE_DIR: join(storageDir, 'photos'),
    TRANSFORM_PNG_MAX_INPUT_BYTES: String(MAX_RASTER),
    TRANSFORM_JPEG_MAX_INPUT_BYTES: String(MAX_RASTER),
  });

  const bump = () =>
    app.db.query(
      'UPDATE rbac_policy_state SET version = version + 1 WHERE id = 1',
    );

  async function createUser(
    label: string,
    options: { status?: string; role?: string } = {},
  ): Promise<string> {
    const rows: { id: string }[] = await app.db.query(
      `INSERT INTO users (email, password_hash, status)
       VALUES ($1, 'x-hash', $2) RETURNING id`,
      [`${unique(label)}${DOMAIN}`, options.status ?? 'active'],
    );
    await app.db.query(
      'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
      [rows[0].id, options.role ?? convertRole],
    );
    await bump();
    return rows[0].id;
  }

  async function cookieOf(userId?: string): Promise<Record<string, string>> {
    if (!userId) return {};
    const { access } = await app
      .get(TokenService, { strict: false })
      .issuePair(userId);
    return { cookie: `access_token=${access}` };
  }

  async function convert(
    as: string | undefined,
    parts: Part[] | { raw: string; contentType: string },
    extra: Record<string, string> = {},
  ) {
    const { payload, contentType } = Array.isArray(parts)
      ? multipart(parts)
      : { payload: parts.raw, contentType: parts.contentType };
    return app.inject({
      method: 'POST',
      url: '/images/convert',
      headers: {
        ...(await cookieOf(as)),
        'content-type': contentType,
        ...extra,
      },
      payload,
    });
  }

  const upload = (
    target: string,
    sample: Part,
    options?: Record<string, unknown>,
    extra: Part[] = [],
  ): Part[] => [
    { field: 'targetFormat', value: target },
    ...(options ? [{ field: 'options', value: JSON.stringify(options) }] : []),
    ...extra,
    sample,
  ];

  const history = (userId: string) =>
    app.db.query(
      'SELECT * FROM transformations WHERE user_id = $1 ORDER BY created_at, id',
      [userId],
    );

  async function expectTempEmpty(): Promise<void> {
    for (let attempt = 0; attempt < 150; attempt++) {
      if ((await readdir(tempDir)).length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await readdir(tempDir)).toEqual([]);
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'imageformats-temp-'));
    storageDir = await mkdtemp(join(tmpdir(), 'imageformats-store-'));
    if (!transactionalReady) {
      initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });
      transactionalReady = true;
    }
    const values = env();
    const config = { get: (key: string) => values[key] ?? process.env[key] };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(MailService)
      .useValue({})
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ routerOptions: { maxParamLength: 256 } }),
    ) as TestApp;
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    app.useGlobalFilters(new ProblemDetailsExceptionFilter());
    await setupHttp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    app.db = app.get(DataSource);

    await app.db.query(
      `INSERT INTO permissions (name, actions)
       VALUES ('transformations', '{convert,history,history_any,download,download_any}')
       ON CONFLICT (name) DO NOTHING`,
    );
    await app.db.query(
      `INSERT INTO permissions (name, actions) VALUES ('users', '{read}')
       ON CONFLICT (name) DO NOTHING`,
    );
    const role = async (label: string, grants: [string, string[]][]) => {
      const roles: { id: string }[] = await app.db.query(
        'INSERT INTO roles (name) VALUES ($1) RETURNING id',
        [unique(label)],
      );
      for (const [permission, actions] of grants) {
        await app.db.query(
          `INSERT INTO role_grants (role_id, permission_id, all_actions, actions)
           SELECT $1, id, false, $2::varchar[] FROM permissions WHERE name = $3`,
          [roles[0].id, actions, permission],
        );
      }
      return roles[0].id;
    };
    convertRole = await role('convert', [['transformations', ['convert']]]);
    plainRole = await role('plain', [['users', ['read']]]);
    await bump();
  });

  afterAll(async () => {
    await app.db.query(`DELETE FROM users WHERE email LIKE '${PREFIX}-%'`);
    await app.db.query(
      `DELETE FROM role_grants WHERE role_id IN
         (SELECT id FROM roles WHERE name LIKE '${PREFIX}-%')`,
    );
    await app.db.query(`DELETE FROM roles WHERE name LIKE '${PREFIX}-%'`);
    await bump();
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  });

  describe('GET /images/convert/formats', () => {
    const get = async (as?: string) =>
      app.inject({
        method: 'GET',
        url: '/images/convert/formats',
        headers: await cookieOf(as),
      });

    it('401 without a session and for an inactive user', async () => {
      expect((await get()).statusCode).toBe(401);
      expect(
        (await get(await createUser('f-blocked', { status: 'blocked' })))
          .statusCode,
      ).toBe(401);
    });

    it('403 without transformations@convert', async () => {
      const res = await get(await createUser('f-plain', { role: plainRole }));
      expect(res.statusCode).toBe(403);
    });

    it('lists the supported directions', async () => {
      const res = await get(await createUser('f-ok'));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        { source: 'png', target: ['jpeg'] },
        { source: 'jpeg', target: ['png'] },
        { source: 'svg', target: ['png', 'jpeg'] },
      ]);
    });
  });

  describe('access order (before any file is parsed)', () => {
    it('401 without a session', async () => {
      const body = upload('jpeg', png(await solid(2, 2, 'png')));
      expect((await convert(undefined, body)).statusCode).toBe(401);
    });

    it('401 for a user that is not active', async () => {
      const blocked = await createUser('blocked', { status: 'blocked' });
      const body = upload('jpeg', png(await solid(2, 2, 'png')));
      expect((await convert(blocked, body)).statusCode).toBe(401);
    });

    it('403 without the permission, even for a body that is no multipart', async () => {
      const userId = await createUser('plain', { role: plainRole });
      const res = await convert(userId, {
        raw: 'not multipart',
        contentType: 'text/plain',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('permission_denied');
      expect(await history(userId)).toEqual([]);
    });

    it('403 for a cross-origin request without the CSRF header', async () => {
      const userId = await createUser('csrf');
      const res = await convert(
        userId,
        upload('jpeg', png(await solid(2, 2, 'png'))),
        { origin: 'https://evil.example' },
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('csrf_rejected');
      expect(await history(userId)).toEqual([]);
    });

    it('415 for a body that is no multipart (authorized user)', async () => {
      const userId = await createUser('nomultipart');
      const res = await convert(userId, {
        raw: '{}',
        contentType: 'application/json',
      });
      expect(res.statusCode).toBe(415);
    });
  });

  describe('the four directions', () => {
    it('png -> jpeg, with history', async () => {
      const userId = await createUser('png-jpeg');
      const input = await solid(8, 4, 'png');

      const res = await convert(userId, upload('jpeg', png(input)));

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="converted.jpeg"',
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(await dims(res.rawPayload)).toEqual(['jpeg', 8, 4]);
      const rows = await history(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: 'image',
        source_format: 'png',
        target_format: 'jpeg',
        status: 'success',
        error_code: null,
      });
      expect(Number(rows[0].input_size)).toBe(input.length);
      expect(Number(rows[0].output_size)).toBe(res.rawPayload.length);
      await expectTempEmpty();
    });

    it('jpeg -> png', async () => {
      const userId = await createUser('jpeg-png');
      const res = await convert(
        userId,
        upload('png', jpeg(await solid(6, 6, 'jpeg'))),
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="converted.png"',
      );
      expect(await dims(res.rawPayload)).toEqual(['png', 6, 6]);
      expect((await history(userId))[0]).toMatchObject({
        type: 'image',
        source_format: 'jpeg',
        target_format: 'png',
      });
    });

    it.each([
      ['png', 'image/png'],
      ['jpeg', 'image/jpeg'],
    ])('svg -> %s', async (target, contentType) => {
      const userId = await createUser(`svg-${target}`);
      const res = await convert(
        userId,
        upload(target, svgFile(SVG('width="40" height="20"'))),
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe(contentType);
      expect(await dims(res.rawPayload)).toEqual([target, 40, 20]);
      // The raw SVG is never returned.
      expect(res.rawPayload.includes(Buffer.from('<svg'))).toBe(false);
      await expectTempEmpty();
    });
  });

  describe('options', () => {
    it('flattens png transparency onto the chosen background', async () => {
      const userId = await createUser('alpha');
      const input = await solid(4, 4, 'png', 0);

      const white = await convert(userId, upload('jpeg', png(input)));
      const blue = await convert(
        userId,
        upload('jpeg', png(input), { background: '#0000ff', quality: 100 }),
      );

      const first = await sharp(white.rawPayload).raw().toBuffer();
      const second = await sharp(blue.rawPayload).raw().toBuffer();
      expect([...first.subarray(0, 3)].every((v) => v > 240)).toBe(true);
      expect(second[2]).toBeGreaterThan(240);
      expect(second[0]).toBeLessThan(15);
    });

    it('quality changes the output size', async () => {
      const userId = await createUser('quality');
      const input = png(
        await sharp(await noise(48))
          .png()
          .toBuffer(),
      );
      const high = await convert(
        userId,
        upload('jpeg', input, { quality: 100 }),
      );
      const low = await convert(userId, upload('jpeg', input, { quality: 5 }));
      expect(low.rawPayload.length).toBeLessThan(high.rawPayload.length);
    });

    it('applies EXIF orientation and strips all metadata', async () => {
      const userId = await createUser('exif');
      const source = await sharp(await solid(4, 2, 'png'))
        .jpeg()
        .withMetadata({
          orientation: 6,
          exif: {
            IFD0: { Copyright: 'private-owner' },
            IFD3: { GPSLatitudeRef: 'N' },
          },
        })
        .toBuffer();

      const res = await convert(userId, upload('png', jpeg(source)));

      expect(res.statusCode).toBe(200);
      expect(await dims(res.rawPayload)).toEqual(['png', 2, 4]);
      const meta = await sharp(res.rawPayload).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
      expect(res.rawPayload.includes(Buffer.from('private-owner'))).toBe(false);
      expect(res.rawPayload.includes(Buffer.from('private-name'))).toBe(false);
    });

    it('resizes an svg: ratio kept for one side, exact size for both', async () => {
      const userId = await createUser('svg-size');
      const input = svgFile(SVG('width="40" height="20"'));

      const byWidth = await convert(
        userId,
        upload('png', input, { width: 200 }),
      );
      const byHeight = await convert(
        userId,
        upload('png', input, { height: 10 }),
      );
      const both = await convert(
        userId,
        upload('png', input, { width: 64, height: 64 }),
      );

      expect(await dims(byWidth.rawPayload)).toEqual(['png', 200, 100]);
      expect(await dims(byHeight.rawPayload)).toEqual(['png', 20, 10]);
      expect(await dims(both.rawPayload)).toEqual(['png', 64, 64]);
      // Stretched: the 2:1 red rect fills the square, no transparent padding.
      const { data } = await sharp(both.rawPayload)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(data[3]).toBe(255);
      expect(data[(63 * 64 + 32) * 4 + 3]).toBe(255);
    });

    it('uses 1024x1024 for an svg without any size', async () => {
      const userId = await createUser('svg-fallback');
      const res = await convert(userId, upload('png', svgFile(SVG(''))));
      expect(await dims(res.rawPayload)).toEqual(['png', 1024, 1024]);
    });

    it.each([
      ['quality for a png target', 'svg', 'png', { quality: 50 }],
      ['background for a png target', 'svg', 'png', { background: '#000000' }],
      ['width for a png source', 'png', 'jpeg', { width: 10 }],
      ['height for a jpeg source', 'jpeg', 'png', { height: 10 }],
      ['an unknown option', 'png', 'jpeg', { sharpen: 1 }],
      ['quality 0', 'png', 'jpeg', { quality: 0 }],
      ['quality 101', 'png', 'jpeg', { quality: 101 }],
      ['a string quality', 'png', 'jpeg', { quality: '80' }],
      ['a bad colour', 'png', 'jpeg', { background: 'red' }],
      ['width 4097', 'svg', 'png', { width: 4097 }],
      ['width 0', 'svg', 'png', { width: 0 }],
    ])('400 for %s', async (_label, source, target, options) => {
      const userId = await createUser('opt');
      const file =
        source === 'svg'
          ? svgFile(SVG('width="4" height="4"'))
          : source === 'png'
            ? png(await solid(4, 4, 'png'))
            : jpeg(await solid(4, 4, 'jpeg'));

      const res = await convert(userId, upload(target, file, options));

      expect(res.statusCode).toBe(400);
      await expectTempEmpty();
    });

    it('400 for options that are not a JSON object', async () => {
      const userId = await createUser('opt-json');
      const file = png(await solid(4, 4, 'png'));
      for (const value of ['nope', '[]', 'null', '"x"']) {
        const res = await convert(userId, [
          { field: 'targetFormat', value: 'jpeg' },
          { field: 'options', value },
          file,
        ]);
        expect(res.statusCode).toBe(400);
      }
    });
  });

  describe('unsupported conversions', () => {
    it.each([
      ['raster to svg', 'svg', 'png'],
      ['jpeg to svg', 'svg', 'jpeg'],
      ['png to png', 'png', 'png'],
      ['jpeg to jpeg', 'jpeg', 'jpeg'],
      ['png to gif', 'gif', 'png'],
    ])('415 for %s', async (_label, target, source) => {
      const userId = await createUser('unsupported');
      const file =
        source === 'png'
          ? png(await solid(4, 4, 'png'))
          : jpeg(await solid(4, 4, 'jpeg'));
      const res = await convert(userId, upload(target, file));
      expect(res.statusCode).toBe(415);
      await expectTempEmpty();
    });

    it('415 for svg to svg, an unsupported extension and a wrong MIME type', async () => {
      const userId = await createUser('unsupported-2');
      expect(
        (await convert(userId, upload('svg', svgFile(SVG('width="1"')))))
          .statusCode,
      ).toBe(415);
      expect(
        (
          await convert(
            userId,
            upload('png', {
              file: 'GIF89a',
              filename: 'a.gif',
              mime: 'image/gif',
            }),
          )
        ).statusCode,
      ).toBe(415);
      expect(
        (
          await convert(
            userId,
            upload('jpeg', {
              file: await solid(4, 4, 'png'),
              filename: 'a.png',
              mime: 'text/html',
            }),
          )
        ).statusCode,
      ).toBe(415);
    });
  });

  describe('invalid and malicious files', () => {
    const SIZE = 'width="10" height="10"';
    const MALICIOUS: [string, string][] = [
      [
        'an XXE entity',
        `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>${SVG(SIZE, '<text>&x;</text>')}`,
      ],
      ['a script', SVG(SIZE, '<script>alert(1)</script>')],
      ['a foreignObject', SVG(SIZE, '<foreignObject><p>x</p></foreignObject>')],
      ['an event handler', SVG(`${SIZE} onload="alert(1)"`)],
      [
        'an external image',
        SVG(
          SIZE,
          '<image href="http://127.0.0.1:9/x.png" width="5" height="5"/>',
        ),
      ],
      [
        'an external stylesheet',
        SVG(SIZE, '<style>@import url(http://127.0.0.1:9/a.css);</style>'),
      ],
    ];

    it.each(MALICIOUS)('400 for an SVG with %s', async (_label, text) => {
      const userId = await createUser('evil');

      const res = await convert(userId, upload('png', svgFile(text)));

      expect(res.statusCode).toBe(400);
      expect(res.rawPayload.includes(Buffer.from('/etc/passwd'))).toBe(false);
      const rows = await history(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: 'image',
        status: 'error',
        error_code: 'invalid_input',
        output_size: null,
      });
      await expectTempEmpty();
    });

    it('400 for a corrupt image and for a file that is not the declared format', async () => {
      const userId = await createUser('corrupt');
      expect(
        (await convert(userId, upload('jpeg', png(Buffer.from('not a png')))))
          .statusCode,
      ).toBe(400);
      expect(
        (await convert(userId, upload('jpeg', png(await solid(4, 4, 'jpeg')))))
          .statusCode,
      ).toBe(400);
      expect(
        (await convert(userId, upload('png', svgFile('<not-svg/>'))))
          .statusCode,
      ).toBe(400);
      await expectTempEmpty();
    });
  });

  describe('limits', () => {
    it('413 for a file over the size limit', async () => {
      const userId = await createUser('too-large');
      const big = await noise(300);
      expect(big.length).toBeGreaterThan(MAX_RASTER);

      const res = await convert(userId, upload('jpeg', png(big)));

      expect(res.statusCode).toBe(413);
      await expectTempEmpty();
    });

    it.each([
      ['a side over 4096', 4097, 1],
      ['more than 16,777,216 pixels', 4096, 4097],
    ])('413 for %s, decided from the header', async (_label, w, h) => {
      const userId = await createUser('pixels');
      const canvas = await sharp({
        create: { width: w, height: h, channels: 3, background: '#808080' },
      })
        .png({ compressionLevel: 9 })
        .toBuffer();
      expect(canvas.length).toBeLessThan(MAX_RASTER);

      const res = await convert(userId, upload('jpeg', png(canvas)));

      expect(res.statusCode).toBe(413);
      expect((await history(userId))[0]).toMatchObject({
        status: 'error',
        error_code: 'image_too_large',
      });
      await expectTempEmpty();
    });

    it('413 for an svg that would render over 4096 pixels', async () => {
      const userId = await createUser('svg-big');
      const res = await convert(
        userId,
        upload('png', svgFile(SVG('width="5000" height="10"'))),
      );
      expect(res.statusCode).toBe(413);
      expect((await history(userId))[0]).toMatchObject({
        status: 'error',
        error_code: 'image_too_large',
      });
    });
  });

  describe('request body rules', () => {
    it('400 for an unexpected field, recorded as an image error', async () => {
      const userId = await createUser('extra-field');
      const res = await convert(
        userId,
        upload('jpeg', png(await solid(4, 4, 'png')), undefined, [
          { field: 'format', value: 'png' },
        ]),
      );
      expect(res.statusCode).toBe(400);
      expect((await history(userId))[0]).toMatchObject({
        type: 'image',
        status: 'error',
        error_code: 'invalid_input',
      });
    });

    it('400 for a missing file and for an invalid save value', async () => {
      const userId = await createUser('body');
      expect(
        (await convert(userId, [{ field: 'targetFormat', value: 'png' }]))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await convert(
            userId,
            upload('jpeg', png(await solid(4, 4, 'png')), undefined, [
              { field: 'save', value: 'maybe' },
            ]),
          )
        ).statusCode,
      ).toBe(400);
    });

    it('accepts the fields after the file', async () => {
      const userId = await createUser('order');
      const res = await convert(userId, [
        png(await solid(4, 4, 'png')),
        { field: 'targetFormat', value: 'jpeg' },
        { field: 'options', value: '{"quality":60}' },
      ]);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('save', () => {
    it('keeps nothing in the temp area and reports the storage status', async () => {
      const userId = await createUser('save');
      const res = await convert(
        userId,
        upload('jpeg', png(await solid(4, 4, 'png')), undefined, [
          { field: 'save', value: 'true' },
        ]),
      );
      expect(res.statusCode).toBe(200);
      expect(['pending', 'failed']).toContain(res.headers['x-storage-status']);
      await expectTempEmpty();
    });

    it('does not store the result without save', async () => {
      const userId = await createUser('nosave');
      const res = await convert(
        userId,
        upload('jpeg', png(await solid(4, 4, 'png'))),
      );
      expect(res.headers['x-storage-status']).toBe('none');
    });
  });
});
