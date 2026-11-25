/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import {
  Controller,
  Module,
  Post,
  Query,
  Req,
  Res,
  ValidationPipe,
} from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { FastifyReply } from 'fastify';
import { existsSync } from 'fs';
import { mkdtemp, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import { DataSource } from 'typeorm';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { AppModule } from '../src/core/app/app.module';
import { ConfigService } from '../src/core/config/config.service';
import { setupHttp } from '../src/core/http/http-setup';
import { AuthModule } from '../src/modules/auth/auth.module';
import { invalidRequest } from '../src/modules/auth/errors/auth.errors';
import { ProblemDetailsExceptionFilter } from '../src/modules/auth/errors/problem-details-exception.filter';
import { CsrfGuard } from '../src/modules/auth/guards/csrf.guard';
import { MailService } from '../src/modules/auth/services/mail.service';
import { TokenService } from '../src/modules/auth/services/token.service';
import { SessionModule } from '../src/modules/auth/session.module';
import {
  TRANSFORMATIONS_CONVERT_ACTION,
  TRANSFORMATIONS_PERMISSION,
} from '../src/modules/rbac/rbac.constants';
import { RequirePermission } from '../src/modules/rbac/rbac.decorators';
import { RbacModule } from '../src/modules/rbac/rbac.module';
import type { RbacRequest } from '../src/modules/rbac/rbac.types';
import { TransformationsReadinessIndicator } from '../src/modules/transformations/health/transformations.health';
import { ConverterRegistry } from '../src/modules/transformations/services/converter.registry';
import type {
  ConversionRequest,
  Converter,
} from '../src/modules/transformations/services/converter';
import { TransformationEraser } from '../src/modules/transformations/services/transformation-eraser';
import { TransformationHistoryService } from '../src/modules/transformations/services/transformation-history.service';
import { TransformationService } from '../src/modules/transformations/services/transformation.service';
import { TransformationsPolicyService } from '../src/modules/transformations/services/transformations-policy.service';
import { TextConvertersService } from '../src/modules/text-formats/services/text-converters.service';
import { TransformationsModule } from '../src/modules/transformations/transformations.module';
import { UserEraserRegistry } from '../src/modules/users/deletion/services/user-eraser.registry';

/**
 * The real guard chain (access token -> CSRF -> RBAC) in front of the shared
 * transformation service. The HTTP operations of the formats belong to later
 * tasks; this controller only exists in the test.
 */
@Controller('e2e-transform')
class ConvertTestController {
  constructor(private readonly service: TransformationService) {}

  @Post()
  @RequirePermission(TRANSFORMATIONS_PERMISSION, TRANSFORMATIONS_CONVERT_ACTION)
  async convert(
    @Req() request: RbacRequest,
    @Res() reply: FastifyReply,
    @Query('target') target = 'json',
    @Query('save') save?: string,
  ): Promise<void> {
    const part = await request.file().catch(() => {
      throw invalidRequest('Send one multipart file');
    });
    if (!part) throw invalidRequest('The file field is missing');
    const result = await this.service.convert({
      requestId: String(request.id),
      userId: request.user?.id ?? '',
      sourceFormat: 'csv',
      targetFormat: target,
      input: part.file,
      isTruncated: () => part.file.truncated,
      save: save === 'true',
    });
    void reply
      .status(200)
      .header('content-type', result.contentType)
      .header('x-transformation-id', result.transformationId)
      .header('x-save-status', result.saveStatus)
      .send(result.stream);
  }
}

@Module({
  imports: [TransformationsModule, SessionModule, RbacModule, AuthModule],
  controllers: [ConvertTestController],
  providers: [CsrfGuard],
})
class ConvertTestModule {}

const PREFIX = 'transform-spec';
const DOMAIN = '@example.test';
const BODY = 'a,b\n1,2\n';
const SECRET = 'LIBRARY-SECRET /srv/private/path';
let counter = 0;
const unique = (label: string) =>
  `${PREFIX}-${label}-${Date.now()}-${counter++}`;

type TestApp = NestFastifyApplication & { db: DataSource };
let transactionalReady = false;

const upper = () =>
  new Transform({
    transform(chunk: Buffer, _enc, cb) {
      cb(null, Buffer.from(chunk.toString('utf8').toUpperCase()));
    },
  });

const converter = (
  target: string,
  convert: (request: ConversionRequest) => ReturnType<Converter['convert']>,
  limits: Partial<Converter['limits']> = {},
): Converter => ({
  type: 'file' as Converter['type'],
  source: 'csv',
  target,
  limits: {
    maxInputBytes: 1024 * 1024,
    maxOutputBytes: 1024 * 1024,
    timeoutMs: 5000,
    ...limits,
  },
  convert,
});

function multipartBody(data: Buffer | string) {
  const boundary = '----transformspec' + Date.now();
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="private-name.csv"\r\nContent-Type: text/csv\r\n\r\n`,
    ),
    Buffer.from(data),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('File transformations foundation (e2e)', () => {
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

  async function convert(
    as: string | undefined,
    options: {
      query?: string;
      data?: Buffer | string;
      origin?: string;
      csrf?: boolean;
      raw?: { payload: string; contentType: string };
    } = {},
  ) {
    const headers: Record<string, string> = {};
    if (as) {
      const { access } = await app
        .get(TokenService, { strict: false })
        .issuePair(as);
      headers.cookie = `access_token=${access}`;
    }
    if (options.origin) headers.origin = options.origin;
    if (options.csrf) headers['x-csrf-protection'] = '1';
    const { payload, contentType } =
      options.raw ?? multipartBody(options.data ?? BODY);
    headers['content-type'] = contentType;
    return app.inject({
      method: 'POST',
      url: `/e2e-transform${options.query ?? ''}`,
      headers,
      payload,
    });
  }

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
    tempDir = await mkdtemp(join(tmpdir(), 'transform-temp-'));
    storageDir = await mkdtemp(join(tmpdir(), 'transform-store-'));
    if (!transactionalReady) {
      initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });
      transactionalReady = true;
    }
    const values = env();
    const config = { get: (key: string) => values[key] ?? process.env[key] };
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, ConvertTestModule],
    })
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(MailService)
      .useValue({})
      // This suite registers its own csv converters in place of the real ones.
      .overrideProvider(TextConvertersService)
      .useValue({ onModuleInit: () => undefined })
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

    const registry = app.get(ConverterRegistry);
    registry.register(
      converter('json', async ({ input, output }) => {
        await pipeline(input, upper(), output);
        return {
          ok: true,
          contentType: 'application/json',
          extension: 'json',
          size: 0,
        };
      }),
    );
    registry.register(
      converter('xml', () =>
        Promise.resolve({ ok: false, code: 'invalid_input' }),
      ),
    );
    registry.register(
      converter('yaml', () => Promise.reject(new Error(SECRET))),
    );
    registry.register(
      converter(
        'slow',
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
          }),
        { timeoutMs: 50 },
      ),
    );
    registry.register(
      converter(
        'tiny',
        ({ input, output }) =>
          pipeline(input, output).then(() => ({
            ok: true as const,
            contentType: 'text/plain',
            extension: 'txt',
            size: 0,
          })),
        { maxInputBytes: 4 },
      ),
    );
    registry.register(
      converter(
        'big',
        async ({ input, output }) => {
          await pipeline(input, output);
          return {
            ok: true,
            contentType: 'text/plain',
            extension: 'txt',
            size: 0,
          };
        },
        { maxOutputBytes: 4 },
      ),
    );

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

  describe('access order (before any file is parsed)', () => {
    it('401 without a session', async () => {
      const res = await convert(undefined);
      expect(res.statusCode).toBe(401);
    });

    it('401 for a user that is not active', async () => {
      const blocked = await createUser('blocked', { status: 'blocked' });
      const res = await convert(blocked);
      expect(res.statusCode).toBe(401);
    });

    it('403 without transformations@convert, even for a body that is no multipart at all', async () => {
      const userId = await createUser('plain', { role: plainRole });

      const res = await convert(userId, {
        raw: { payload: 'not multipart', contentType: 'text/plain' },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('permission_denied');
      expect(await history(userId)).toEqual([]);
    });

    it('with the permission, the same broken body is a 400 (parsing happens after the check)', async () => {
      const userId = await createUser('broken');
      const res = await convert(userId, {
        raw: { payload: 'not multipart', contentType: 'text/plain' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('403 for a cross-origin request without the CSRF header, before the permission check', async () => {
      const userId = await createUser('csrf');

      const res = await convert(userId, { origin: 'https://evil.example' });

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('csrf_rejected');
      expect(await history(userId)).toEqual([]);
    });
  });

  describe('conversion', () => {
    it('200 with the whole result, a success row without contents, and no temp files left', async () => {
      const userId = await createUser('ok');

      const res = await convert(userId, { query: '?target=json' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.body).toBe(BODY.toUpperCase());
      const rows = await history(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: res.headers['x-transformation-id'],
        user_id: userId,
        type: 'file',
        source_format: 'csv',
        target_format: 'json',
        status: 'success',
        error_code: null,
      });
      expect(Number(rows[0].input_size)).toBe(BODY.length);
      expect(Number(rows[0].output_size)).toBe(BODY.length);
      expect(rows[0].duration_ms).toBeGreaterThanOrEqual(0);
      expect((rows[0].completed_at as Date).getTime()).toBeGreaterThanOrEqual(
        (rows[0].created_at as Date).getTime(),
      );
      // Only metadata: no column can hold contents, a name or an email.
      expect(Object.keys(rows[0]).sort()).toEqual(
        [
          'completed_at',
          'created_at',
          'duration_ms',
          'error_code',
          'id',
          'input_size',
          'output_size',
          'source_format',
          'status',
          'storage_error_code',
          'storage_status',
          'stored_file_key',
          'stored_file_until',
          'target_format',
          'type',
          'user_id',
        ].sort(),
      );
      expect(JSON.stringify(rows[0])).not.toContain('private-name');
      await expectTempEmpty();
    });

    it('415 for an unsupported direction; nothing is recorded', async () => {
      const userId = await createUser('unsupported');
      const res = await convert(userId, { query: '?target=pdf' });
      expect(res.statusCode).toBe(415);
      expect(await history(userId)).toEqual([]);
      await expectTempEmpty();
    });

    it('400 for a library error: an error row with a safe code, no temp files', async () => {
      const userId = await createUser('lib-error');

      const res = await convert(userId, { query: '?target=xml' });

      expect(res.statusCode).toBe(400);
      const rows = await history(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'error',
        error_code: 'invalid_input',
        output_size: null,
      });
      await expectTempEmpty();
    });

    it('never leaks an unexpected library message, path or stack', async () => {
      const userId = await createUser('leak');

      const res = await convert(userId, { query: '?target=yaml' });

      expect(res.statusCode).toBe(400);
      expect(res.body).not.toMatch(
        /LIBRARY-SECRET|private|\.ts|stack|node_modules/,
      );
      expect((await history(userId))[0]).toMatchObject({
        error_code: 'conversion_failed',
      });
      await expectTempEmpty();
    });

    it('504 on a timeout, recorded, no temp files', async () => {
      const userId = await createUser('timeout');

      const res = await convert(userId, { query: '?target=slow' });

      expect(res.statusCode).toBe(504);
      expect((await history(userId))[0]).toMatchObject({
        status: 'error',
        error_code: 'timeout',
      });
      await expectTempEmpty();
    });

    it('413 for an upload above the limit of the direction; nothing is recorded', async () => {
      const userId = await createUser('too-large');
      const res = await convert(userId, { query: '?target=tiny' });
      expect(res.statusCode).toBe(413);
      expect(await history(userId)).toEqual([]);
      await expectTempEmpty();
    });

    it('413 for a result above the limit; recorded', async () => {
      const userId = await createUser('big-output');
      const res = await convert(userId, { query: '?target=big' });
      expect(res.statusCode).toBe(413);
      expect((await history(userId))[0]).toMatchObject({
        status: 'error',
        error_code: 'output_too_large',
      });
      await expectTempEmpty();
    });

    it('400 for an empty file', async () => {
      const userId = await createUser('empty');
      const res = await convert(userId, { data: '' });
      expect(res.statusCode).toBe(400);
      await expectTempEmpty();
    });
  });

  describe('mandatory history', () => {
    it('503 and no converted file when the history cannot be written; temp files are removed', async () => {
      const userId = await createUser('history-down');
      const spy = jest
        .spyOn(app.get(TransformationHistoryService), 'record')
        .mockRejectedValueOnce(new Error('connection lost'));

      const res = await convert(userId, { query: '?target=json' });

      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain(BODY.toUpperCase());
      expect(res.body).not.toContain('connection');
      expect(res.json().code).toBe('transformation_unavailable');
      expect(await history(userId)).toEqual([]);
      await expectTempEmpty();
      spy.mockRestore();
    });
  });

  describe('save=true', () => {
    it('stages an opaque copy as pending without delaying the response, and the eraser removes it', async () => {
      const userId = await createUser('save');

      const res = await convert(userId, { query: '?target=json&save=true' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-save-status']).toBe('pending');
      expect(res.body).toBe(BODY.toUpperCase());
      const rows: {
        storage_status: string;
        stored_file_key: string;
        stored_file_until: Date | null;
        storage_error_code: string | null;
      }[] = await app.db.query('SELECT * FROM transformations WHERE id = $1', [
        res.headers['x-transformation-id'],
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].storage_status).toBe('pending');
      expect(rows[0].stored_file_key).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(rows[0].stored_file_until).toBeNull();
      expect(rows[0].storage_error_code).toBeNull();
      const copy = join(storageDir, 'pending', rows[0].stored_file_key);
      expect(existsSync(copy)).toBe(true);
      await expectTempEmpty();

      const eraser = app.get(TransformationEraser);
      await expect(eraser.erase(userId)).resolves.toEqual({
        status: 'succeeded',
      });
      expect(existsSync(copy)).toBe(false);
      expect(await history(userId)).toEqual([]);

      // A repeated run is safe.
      await expect(eraser.erase(userId)).resolves.toEqual({
        status: 'succeeded',
      });
    });

    it('stores nothing without the flag', async () => {
      const userId = await createUser('nosave');
      const res = await convert(userId, { query: '?target=json' });
      expect(res.headers['x-save-status']).toBe('not_requested');
      const rows: { storage_status: string; stored_file_key: string | null }[] =
        await app.db.query(
          'SELECT storage_status, stored_file_key FROM transformations WHERE id = $1',
          [res.headers['x-transformation-id']],
        );
      expect(rows).toEqual([
        { storage_status: 'not_requested', stored_file_key: null },
      ]);
    });
  });

  describe('user deletion', () => {
    it('is registered, so deletion cannot finish while history is left behind', () => {
      expect(app.get(UserEraserRegistry).missing()).toEqual([]);
    });

    it('erases the history rows of the user only', async () => {
      const a = await createUser('erase-a');
      const b = await createUser('erase-b');
      await convert(a);
      await convert(b);

      await app.get(TransformationEraser).erase(a);

      expect(await history(a)).toEqual([]);
      expect(await history(b)).toHaveLength(1);
    });

    it('rows follow the user (FK) as a safety net', async () => {
      const userId = await createUser('fk');
      await convert(userId);
      await app.db.query('DELETE FROM users WHERE id = $1', [userId]);
      expect(await history(userId)).toEqual([]);
    });
  });

  describe('permission setup and readiness', () => {
    interface DefaultGrant {
      name: string;
      all_actions: boolean;
      actions: string[];
    }
    const permissionRow = async () =>
      (
        await app.db.query(
          `SELECT id, actions FROM permissions WHERE name = 'transformations'`,
        )
      )[0] as { id: string; actions: string[] } | undefined;
    const defaultGrants = async (permissionId: string) => {
      const grants: DefaultGrant[] = await app.db.query(
        `SELECT r.name, g.all_actions, g.actions
           FROM role_grants g JOIN roles r ON r.id = g.role_id
          WHERE g.permission_id = $1 AND r.name IN ('user', 'admin')`,
        [permissionId],
      );
      return Object.fromEntries(grants.map((g) => [g.name, g]));
    };
    const expectDefaults = async (permissionId: string) => {
      const byRole = await defaultGrants(permissionId);
      expect([...byRole.user.actions].sort()).toEqual(
        ['convert', 'download', 'history'].sort(),
      );
      expect(byRole.user.all_actions).toBe(false);
      expect(byRole.admin.all_actions).toBe(true);
    };

    it('registers the five actions; the user role gets convert, history and download, admin everything', async () => {
      const permission = await permissionRow();
      expect([...(permission?.actions ?? [])].sort()).toEqual(
        [
          'convert',
          'download',
          'download_any',
          'history',
          'history_any',
        ].sort(),
      );
      await expectDefaults(permission!.id);
    });

    it('first setup runs against the real database once; a later run restores nothing', async () => {
      const policy = app.get(TransformationsPolicyService);
      const original = (await permissionRow())!;
      type Grant = { role_id: string; all_actions: boolean; actions: string[] };
      const grantsOf = (permissionId: string): Promise<Grant[]> =>
        app.db.query(
          'SELECT role_id, all_actions, actions FROM role_grants WHERE permission_id = $1',
          [permissionId],
        );
      const snapshot = await grantsOf(original.id);

      try {
        // The permission exists: a removed grant stays removed.
        await app.db.query(
          `DELETE FROM role_grants WHERE permission_id = $1
             AND role_id = (SELECT id FROM roles WHERE name = 'admin')`,
          [original.id],
        );
        await bump();
        const withoutAdmin = (await grantsOf(original.id)).length;
        await expect(policy.ensure()).resolves.toBe('exists');
        expect(await grantsOf(original.id)).toHaveLength(withoutAdmin);

        // Back to the state before the first setup, then run it for real.
        await app.db.query('DELETE FROM role_grants WHERE permission_id = $1', [
          original.id,
        ]);
        await app.db.query('DELETE FROM permissions WHERE id = $1', [
          original.id,
        ]);
        await bump();
        await expect(policy.ensure()).resolves.toBe('created');
        const created = (await permissionRow())!;
        await expectDefaults(created.id);
        await expect(policy.ensure()).resolves.toBe('exists');
      } finally {
        // Leave the shared database as it was found.
        const current = await permissionRow();
        if (!current) {
          await app.db.query(
            `INSERT INTO permissions (id, name, actions) VALUES ($1, 'transformations', $2::varchar[])`,
            [original.id, original.actions],
          );
        } else if (current.id !== original.id) {
          await app.db.query(
            'DELETE FROM role_grants WHERE permission_id = $1',
            [current.id],
          );
          await app.db.query('DELETE FROM permissions WHERE id = $1', [
            current.id,
          ]);
          await app.db.query(
            `INSERT INTO permissions (id, name, actions) VALUES ($1, 'transformations', $2::varchar[])`,
            [original.id, original.actions],
          );
        } else {
          await app.db.query(
            'DELETE FROM role_grants WHERE permission_id = $1',
            [original.id],
          );
        }
        for (const grant of snapshot) {
          await app.db.query(
            `INSERT INTO role_grants (role_id, permission_id, all_actions, actions)
             VALUES ($1, $2, $3, $4::varchar[])`,
            [grant.role_id, original.id, grant.all_actions, grant.actions],
          );
        }
        await bump();
      }
    });

    it('readiness is up with the user role, the permission and a writable temp area', async () => {
      const result = await app.get(TransformationsReadinessIndicator).check();
      expect(result).toEqual({ transformations: { status: 'up' } });
    });
  });
});
