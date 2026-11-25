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

const PREFIX = 'text-formats-spec';
const DOMAIN = '@example.test';
const MAX_INPUT = 2048;
let counter = 0;
const unique = (label: string) =>
  `${PREFIX}-${label}-${Date.now()}-${counter++}`;

type TestApp = NestFastifyApplication & { db: DataSource };
let transactionalReady = false;

type Part =
  | { field: string; value: string }
  | { file: string | Buffer; filename?: string; mime?: string; name?: string };

function multipart(parts: Part[]) {
  const boundary = `----textformats${Date.now()}${counter++}`;
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
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name ?? 'file'}"; filename="${part.filename ?? 'private-name.csv'}"\r\nContent-Type: ${part.mime ?? 'text/csv'}\r\n\r\n`,
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

const CSV = 'name,age\nАнна,001\n"Bob, Jr.","say ""hi"""\n';
const ROWS = [
  { name: 'Анна', age: '001' },
  { name: 'Bob, Jr.', age: 'say "hi"' },
];
const TREE = { r: { '@id': '1', i: ['a', 'b'], n: 't' } };

/** A sample for every source; `rows` ones carry the CSV table, others a tree. */
const SAMPLE = {
  rows: {
    csv: { file: CSV, filename: 'a.csv', mime: 'text/csv' },
    json: {
      file: JSON.stringify(ROWS),
      filename: 'a.json',
      mime: 'application/json',
    },
    yaml: {
      file: '- name: Анна\n  age: "001"\n- name: Bob, Jr.\n  age: say "hi"\n',
      filename: 'a.yml',
      mime: 'application/yaml',
    },
    xml: {
      file: '<rows><row><field name="name">Анна</field><field name="age">001</field></row><row><field name="name">Bob, Jr.</field><field name="age">say &quot;hi&quot;</field></row></rows>',
      filename: 'a.xml',
      mime: 'application/xml',
    },
  },
  tree: {
    json: {
      file: JSON.stringify(TREE),
      filename: 'a.json',
      mime: 'application/json',
    },
    yaml: {
      file: 'r:\n  "@id": "1"\n  i: [a, b]\n  n: t\n',
      filename: 'a.yaml',
      mime: 'application/yaml',
    },
    xml: {
      file: '<r id="1"><i>a</i><i>b</i><n>t</n></r>',
      filename: 'a.xml',
      mime: 'application/xml',
    },
  },
} as const;

const FORMATS = ['csv', 'json', 'xml', 'yaml'] as const;
const PAIRS = FORMATS.flatMap((source) =>
  FORMATS.filter((target) => target !== source).map(
    (target) => [source, target] as const,
  ),
);

describe('Text formats transformation (e2e)', () => {
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
    TRANSFORM_TEXT_MAX_INPUT_BYTES: String(MAX_INPUT),
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
      url: '/convert',
      headers: {
        ...(await cookieOf(as)),
        'content-type': contentType,
        ...extra,
      },
      payload,
    });
  }

  const upload = (target: string, sample: Part, extra: Part[] = []): Part[] => [
    { field: 'targetFormat', value: target },
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

  /** Reads a response body back into plain data through the API itself. */
  async function dataOf(
    userId: string,
    format: string,
    body: string,
    csvPair: boolean,
  ): Promise<unknown> {
    if (format === 'json') return JSON.parse(body);
    const through = async (from: string, to: string, text: string) => {
      const sample = {
        file: text,
        filename: `x.${from}`,
        mime: 'text/plain',
      };
      const res = await convert(userId, upload(to, sample));
      expect(res.statusCode).toBe(200);
      return res.body;
    };
    if (csvPair && format === 'xml') {
      return JSON.parse(
        await through('csv', 'json', await through('xml', 'csv', body)),
      );
    }
    return JSON.parse(await through(format, 'json', body));
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'textformats-temp-'));
    storageDir = await mkdtemp(join(tmpdir(), 'textformats-store-'));
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

  describe('GET /convert/formats', () => {
    const get = async (as?: string) =>
      app.inject({
        method: 'GET',
        url: '/convert/formats',
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

    it('lists the 12 directions', async () => {
      const res = await get(await createUser('f-ok'));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        { source: 'csv', target: ['json', 'xml', 'yaml'] },
        { source: 'json', target: ['csv', 'xml', 'yaml'] },
        { source: 'xml', target: ['csv', 'json', 'yaml'] },
        { source: 'yaml', target: ['csv', 'json', 'xml'] },
      ]);
    });
  });

  describe('access order (before any file is parsed)', () => {
    it('401 without a session', async () => {
      expect(
        (await convert(undefined, upload('json', SAMPLE.rows.csv))).statusCode,
      ).toBe(401);
    });

    it('401 for a user that is not active', async () => {
      const blocked = await createUser('blocked', { status: 'blocked' });
      expect(
        (await convert(blocked, upload('json', SAMPLE.rows.csv))).statusCode,
      ).toBe(401);
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
      const res = await convert(userId, upload('json', SAMPLE.rows.csv), {
        origin: 'https://evil.example',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('csrf_rejected');
      expect(await history(userId)).toEqual([]);
    });
  });

  describe('the 12 directions', () => {
    it.each(PAIRS)('%s -> %s', async (source, target) => {
      const userId = await createUser(`dir-${source}-${target}`);
      const csvPair = source === 'csv' || target === 'csv';
      const sample = (csvPair ? SAMPLE.rows : SAMPLE.tree)[source] as Part;

      const res = await convert(userId, upload(target, sample));

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="converted.${target}"`,
      );
      expect(res.headers['content-type']).toContain(
        {
          csv: 'text/csv',
          json: 'application/json',
          xml: 'application/xml',
          yaml: 'application/yaml',
        }[target],
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(await dataOf(userId, target, res.body, csvPair)).toEqual(
        csvPair ? ROWS : TREE,
      );

      const entries: { id: string; output_size: string }[] =
        await history(userId);
      const [row] = entries.filter(
        (entry) => entry.id === res.headers['x-transformation-id'],
      );
      expect(row).toMatchObject({
        user_id: userId,
        type: 'file',
        source_format: source,
        target_format: target,
        status: 'success',
        error_code: null,
      });
      expect(Number(row.output_size)).toBe(Buffer.byteLength(res.body));
      await expectTempEmpty();
    });

    it('csv -> json keeps strings and Unicode', async () => {
      const userId = await createUser('strings');
      const res = await convert(userId, upload('json', SAMPLE.rows.csv));
      expect(res.json()).toEqual(ROWS);
    });

    it('accepts a UTF-8 BOM and a .yml extension', async () => {
      const userId = await createUser('bom');
      const res = await convert(
        userId,
        upload('json', {
          file: '\uFEFFa: 1\n',
          filename: 'a.yml',
          mime: 'text/yaml',
        }),
      );
      expect(res.json()).toEqual({ a: 1 });
    });

    it('save=true keeps a copy for the background write', async () => {
      const userId = await createUser('save');
      const res = await convert(
        userId,
        upload('json', SAMPLE.rows.csv, [{ field: 'save', value: 'true' }]),
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-save-status']).toBe('pending');
    });
  });

  describe('errors', () => {
    const SECRET = 'TOP-SECRET-CELL-VALUE';

    async function expectRejected(
      label: string,
      sample: Part,
      target: string,
      status: number,
      errorCode: string,
    ) {
      const userId = await createUser(label);
      const res = await convert(userId, upload(target, sample));
      expect(res.statusCode).toBe(status);
      const body = res.body;
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain('private-name');
      expect(body).not.toMatch(/\bat .*\.(ts|js):\d+/);
      const rows = await history(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'error',
        error_code: errorCode,
        output_size: null,
      });
      expect(JSON.stringify(rows[0])).not.toContain(SECRET);
      await expectTempEmpty();
    }

    it.each([
      ['duplicate header', `a,a\n${SECRET},2\n`, 'a.csv', 'text/csv', 'json'],
      ['ragged csv', `a,b\n${SECRET}\n`, 'a.csv', 'text/csv', 'json'],
      [
        'invalid json',
        `{"a":"${SECRET}",}`,
        'a.json',
        'application/json',
        'yaml',
      ],
      [
        'duplicate json key',
        `{"a":"${SECRET}","a":1}`,
        'a.json',
        'application/json',
        'xml',
      ],
      [
        'nested json to csv',
        `[{"a":{"b":"${SECRET}"}}]`,
        'a.json',
        'application/json',
        'csv',
      ],
      [
        'unsafe yaml tag',
        `a: !!js/function "${SECRET}"`,
        'a.yaml',
        'application/yaml',
        'json',
      ],
      [
        'yaml duplicate key',
        `a: ${SECRET}\na: 2\n`,
        'a.yaml',
        'application/yaml',
        'json',
      ],
      [
        'xml with an external entity (XXE)',
        `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>`,
        'a.xml',
        'application/xml',
        'json',
      ],
      ['malformed xml', `<a>${SECRET}</b>`, 'a.xml', 'application/xml', 'yaml'],
      [
        'xml that is not csv-shaped',
        `<other>${SECRET}</other>`,
        'a.xml',
        'application/xml',
        'csv',
      ],
    ])(
      '400 for %s: a safe error code, no content anywhere',
      async (label, file, filename, mime, target) => {
        await expectRejected(
          label.replace(/\W+/g, '-'),
          { file, filename, mime },
          target,
          400,
          'invalid_input',
        );
      },
    );

    it('400 for invalid UTF-8', async () => {
      await expectRejected(
        'utf8',
        {
          file: Buffer.from([0x61, 0x0a, 0xff, 0xfe, 0x0a]),
          filename: 'a.csv',
          mime: 'text/csv',
        },
        'json',
        400,
        'invalid_input',
      );
    });

    it('413 for a file over the input limit', async () => {
      const userId = await createUser('big');
      const res = await convert(
        userId,
        upload('json', {
          file: `a\n${'x'.repeat(MAX_INPUT)}\n`,
          filename: 'a.csv',
          mime: 'text/csv',
        }),
      );
      expect(res.statusCode).toBe(413);
      await expectTempEmpty();
    });

    it('accepts a file exactly at the limit', async () => {
      const userId = await createUser('limit');
      const body = `a\n${'x'.repeat(MAX_INPUT - 2)}`;
      expect(Buffer.byteLength(body)).toBe(MAX_INPUT);
      const res = await convert(
        userId,
        upload('json', { file: body, filename: 'a.csv', mime: 'text/csv' }),
      );
      expect(res.statusCode).toBe(200);
    });

    it.each([
      [
        'an unsupported extension',
        { file: 'a', filename: 'a.txt', mime: 'text/plain' },
        'json',
      ],
      [
        'a MIME type that does not fit',
        { file: 'a\n1\n', filename: 'a.csv', mime: 'image/png' },
        'json',
      ],
      ['an unknown target format', SAMPLE.rows.csv, 'pdf'],
    ])('415 for %s; nothing is recorded', async (label, sample, target) => {
      const userId = await createUser(`u-${label.slice(3, 9).trim()}`);
      const res = await convert(userId, upload(target, sample as Part));
      expect(res.statusCode).toBe(415);
      expect(await history(userId)).toEqual([]);
      await expectTempEmpty();
    });

    it('415 when the body is not multipart', async () => {
      const userId = await createUser('nomultipart');
      const res = await convert(userId, {
        raw: '{"a":1}',
        contentType: 'application/json',
      });
      expect(res.statusCode).toBe(415);
    });

    it.each([
      ['no target', [SAMPLE.rows.csv]],
      ['the target equal to the source', upload('csv', SAMPLE.rows.csv)],
      [
        'an invalid save value',
        upload('json', SAMPLE.rows.csv, [{ field: 'save', value: 'maybe' }]),
      ],
      ['no file', [{ field: 'targetFormat', value: 'json' }]],
      [
        'a file under the wrong name',
        upload('json', { ...SAMPLE.rows.csv, name: 'upload' }),
      ],
      [
        'an empty file',
        upload('json', { file: '', filename: 'a.csv', mime: 'text/csv' }),
      ],
    ])('400 for %s', async (_label, parts) => {
      const userId = await createUser('bad-request');
      const res = await convert(userId, parts as Part[]);
      expect(res.statusCode).toBe(400);
      await expectTempEmpty();
    });
  });

  describe('multipart field order', () => {
    const target: Part = { field: 'targetFormat', value: 'json' };
    const save: Part = { field: 'save', value: 'true' };
    const csv = SAMPLE.rows.csv as Part;

    it.each([
      ['file first', [csv, target, save]],
      ['file in the middle', [save, csv, target]],
      ['file last', [target, save, csv]],
      ['targetFormat after the file, no save', [csv, target]],
    ])('converts with %s', async (label, parts) => {
      const userId = await createUser(`order-${label.slice(0, 8).trim()}`);

      const res = await convert(userId, parts);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(ROWS);
      expect(res.headers['x-save-status']).toBe(
        parts.includes(save) ? 'pending' : 'not_requested',
      );
      const rows = await history(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'success', error_code: null });
      await expectTempEmpty();
    });
  });

  describe('unexpected parts: 400, recorded as an error, never as a success', () => {
    const target: Part = { field: 'targetFormat', value: 'json' };
    const csv = SAMPLE.rows.csv as Part;
    const extraFields = Array.from({ length: 9 }, (_, index) => ({
      field: `extra${index}`,
      value: '1',
    }));

    it.each([
      [
        'an unknown field after the file',
        [target, csv, { field: 'x', value: '1' }],
      ],
      [
        'an unknown field before the file',
        [{ field: 'x', value: '1' }, target, csv],
      ],
      [
        'an unknown field first of all',
        [csv, { field: 'x', value: '1' }, target],
      ],
      [
        'a repeated targetFormat after the file',
        [target, csv, { field: 'targetFormat', value: 'xml' }],
      ],
      [
        'a repeated targetFormat before the file',
        [target, { field: 'targetFormat', value: 'xml' }, csv],
      ],
      ['a second file', [target, csv, csv]],
      [
        'a file under another name after the file',
        [target, csv, { ...csv, name: 'other' }],
      ],
      ['more parts than any request needs', [target, csv, ...extraFields]],
    ] as [string, Part[]][])('%s', async (label, parts) => {
      const userId = await createUser(`extra-${label.slice(0, 12).trim()}`);

      const res = await convert(userId, parts);

      expect(res.statusCode).toBe(400);
      expect(res.headers['content-disposition']).toBeUndefined();
      const rows = await history(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        user_id: userId,
        type: 'file',
        source_format: 'csv',
        target_format: 'json',
        status: 'error',
        error_code: 'invalid_input',
        output_size: null,
      });
      expect(Number(rows[0].input_size)).toBe(Buffer.byteLength(CSV));
      expect(JSON.stringify(rows[0])).not.toContain('private-name');
      expect(res.body).not.toContain('private-name');
      await expectTempEmpty();
    });

    it('stores target "unknown" when the target field is missing', async () => {
      const userId = await createUser('extra-no-target');

      const res = await convert(userId, [csv, { field: 'x', value: '1' }]);

      expect(res.statusCode).toBe(400);
      const rows = await history(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        target_format: 'unknown',
        status: 'error',
        error_code: 'invalid_input',
      });
    });

    it('stores target "unknown" for a target that is no format name', async () => {
      const userId = await createUser('extra-bad-target');

      const res = await convert(userId, [
        { field: 'targetFormat', value: 'not a format!' },
        csv,
        { field: 'x', value: '1' },
      ]);

      expect(res.statusCode).toBe(400);
      expect((await history(userId))[0]).toMatchObject({
        target_format: 'unknown',
        error_code: 'invalid_input',
      });
    });

    it('records nothing for an unsupported extension, even with extra parts', async () => {
      const userId = await createUser('extra-415');

      const res = await convert(userId, [
        target,
        { file: 'a', filename: 'a.txt', mime: 'text/plain' },
        { field: 'x', value: '1' },
      ]);

      expect(res.statusCode).toBe(415);
      expect(await history(userId)).toEqual([]);
    });
  });
});
