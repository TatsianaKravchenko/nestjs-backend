/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { Logger, ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises';
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
import { LocalObjectStorage } from '../src/modules/transformations/services/local-object-storage';
import { StagingStore } from '../src/modules/transformations/services/staging-store';
import { StoredFileWorker } from '../src/modules/transformations/services/stored-file.worker';
import { StorageUnavailableError } from '../src/modules/transformations/services/object-storage';
import { TransformationEraser } from '../src/modules/transformations/services/transformation-eraser';

// Must not start with "e2e-" (the registration e2e deletes 'e2e-%' users).
const PREFIX = 'stored-files-spec';
const DOMAIN = '@example.test';
const RUN = Date.now();
let counter = 0;
const unique = (label: string) =>
  `${PREFIX}-${RUN}-${label}-${counter++}`.toLowerCase();

type TestApp = NestFastifyApplication & { db: DataSource };
let transactionalReady = false;

const CRLF = String.fromCharCode(13, 10);
const CSV = 'name,age\nAnna,1\n';
const JSON_RESULT = [{ name: 'Anna', age: '1' }];

function multipart(fields: Record<string, string>, file = CSV) {
  const boundary = `----storedfiles${RUN}${counter++}`;
  const chunks: Buffer[] = Object.entries(fields).map(([name, value]) =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ),
  );
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="private-name.csv"\r\nContent-Type: text/csv\r\n\r\n${file}\r\n--${boundary}--\r\n`,
    ),
  );
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** Fixed ids, so assertions do not depend on random uuids. */
const rowId = (n: number) =>
  `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;

interface Row {
  storage_status: string;
  stored_file_key: string | null;
  stored_file_until: Date | null;
  storage_error_code: string | null;
}

describe('Saved transformation results (e2e)', () => {
  let app: TestApp;
  let tempDir: string;
  let storageDir: string;
  let userRole: string;
  let noDownloadRole: string;
  let adminRole: string;
  let plainRole: string;
  let worker: StoredFileWorker;

  const env = (): Record<string, string> => ({
    REGISTRATION_CONFIRMATION_ENABLED: 'false',
    API_PUBLIC_URL: 'https://api.test',
    STORAGE_CLEANUP_WORKER_ENABLED: 'false',
    DELETION_WORKER_ENABLED: 'false',
    TRANSFORM_HISTORY_CLEANUP_ENABLED: 'false',
    TRANSFORM_UPLOAD_WORKER_ENABLED: 'false',
    TRANSFORM_STORED_FILE_CLEANUP_ENABLED: 'false',
    TRANSFORM_HISTORY_RATE_LIMIT: '1000',
    TRANSFORM_TEMP_DIR: tempDir,
    TRANSFORM_STORAGE_DIR: storageDir,
    PHOTO_STORAGE_DIR: join(storageDir, 'photos'),
  });

  const bump = () =>
    app.db.query(
      'UPDATE rbac_policy_state SET version = version + 1 WHERE id = 1',
    );

  async function createUser(label: string, role: string): Promise<string> {
    const rows: { id: string }[] = await app.db.query(
      `INSERT INTO users (email, password_hash, status)
       VALUES ($1, 'x-hash', 'active') RETURNING id`,
      [`${unique(label)}${DOMAIN}`],
    );
    await app.db.query(
      'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
      [rows[0].id, role],
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
    as: string,
    fields: Record<string, string>,
    path = '/convert',
  ) {
    const { payload, contentType } = multipart(fields);
    return app.inject({
      method: 'POST',
      url: path,
      headers: { ...(await cookieOf(as)), 'content-type': contentType },
      payload,
    });
  }

  async function convertImage(as: string, fields: Record<string, string>) {
    const png = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 3,
        background: '#336699',
      },
    })
      .png()
      .toBuffer();
    const boundary = `----img${RUN}${counter++}`;
    const head = (disposition: string, type?: string) =>
      ['--' + boundary, disposition, ...(type ? [type] : []), '', ''].join(
        CRLF,
      );
    const payload = Buffer.concat([
      ...Object.entries(fields).map(([name, value]) =>
        Buffer.from(
          head(`Content-Disposition: form-data; name="${name}"`) + value + CRLF,
        ),
      ),
      Buffer.from(
        head(
          'Content-Disposition: form-data; name="file"; filename="a.png"',
          'Content-Type: image/png',
        ),
      ),
      png,
      Buffer.from(CRLF + '--' + boundary + '--' + CRLF),
    ]);
    return app.inject({
      method: 'POST',
      url: '/images/convert',
      headers: {
        ...(await cookieOf(as)),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
  }

  const download = async (as: string | undefined, itemId: string) =>
    app.inject({
      method: 'GET',
      url: `/transformations/history/${itemId}/download`,
      headers: await cookieOf(as),
    });

  const adminDownload = async (
    as: string | undefined,
    userId: string,
    itemId: string,
  ) =>
    app.inject({
      method: 'GET',
      url: `/admin/users/${userId}/transformations/history/${itemId}/download`,
      headers: await cookieOf(as),
    });

  const history = async (as: string) => {
    const res = await app.inject({
      method: 'GET',
      url: '/transformations/history',
      headers: await cookieOf(as),
    });
    expect(res.statusCode).toBe(200);
    return res;
  };

  const rowOf = async (id: string): Promise<Row> => {
    const rows: Row[] = await app.db.query(
      'SELECT * FROM transformations WHERE id = $1',
      [id],
    );
    return rows[0];
  };

  /** A success row that already holds a stored-file state. */
  async function seed(
    userId: string,
    n: number,
    storage: {
      status: string;
      key?: string | null;
      until?: string | null;
      error?: string | null;
    },
    outcome: 'success' | 'error' = 'success',
    target = 'json',
  ): Promise<string> {
    const rid = `00000000-0000-4000-9${String(RUN % 1000).padStart(3, '0')}-${String(
      n,
    ).padStart(12, '0')}`;
    await app.db.query(
      `INSERT INTO transformations
         (id, user_id, type, source_format, target_format, status, input_size,
          output_size, duration_ms, error_code, created_at, completed_at,
          storage_status, stored_file_key, stored_file_until, storage_error_code)
       VALUES ($1, $2, 'file', 'csv', $3, $4, 10, $5, 5, $6, now(), now(),
               $7, $8, $9::timestamptz, $10)`,
      [
        rid,
        userId,
        target,
        outcome,
        outcome === 'success' ? 16 : null,
        outcome === 'error' ? 'conversion_failed' : null,
        storage.status,
        storage.key ?? null,
        storage.until ?? null,
        storage.error ?? null,
      ],
    );
    return rid;
  }

  async function expectTempEmpty(): Promise<void> {
    for (let attempt = 0; attempt < 150; attempt++) {
      if ((await readdir(tempDir)).length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await readdir(tempDir)).toEqual([]);
  }

  /** The problem body without the request path, so two answers can be compared. */
  const shape = (res: { json: () => Record<string, unknown> }) => {
    const { instance, ...rest } = res.json();
    void instance;
    return rest;
  };

  const KEY = (label: string) =>
    `${label}-${RUN}`.replace(/[^A-Za-z0-9_-]/g, '').padEnd(32, 'x');

  async function putObject(key: string, content = 'stored-bytes') {
    await mkdir(join(storageDir, 'objects'), { recursive: true });
    await writeFile(join(storageDir, 'objects', key), content);
  }

  async function putStaged(key: string, content = 'staged-bytes') {
    await mkdir(join(storageDir, 'pending'), { recursive: true });
    await writeFile(join(storageDir, 'pending', key), content);
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'storedfiles-temp-'));
    storageDir = await mkdtemp(join(tmpdir(), 'storedfiles-store-'));
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
    worker = app.get(StoredFileWorker);

    await app.db.query(
      `INSERT INTO permissions (name, actions)
       VALUES ('transformations', '{convert,history,history_any,download,download_any}')
       ON CONFLICT (name) DO NOTHING`,
    );
    await app.db.query(
      `INSERT INTO permissions (name, actions) VALUES ('users', '{read}')
       ON CONFLICT (name) DO NOTHING`,
    );
    const role = async (
      label: string,
      permission: string,
      actions: string[],
    ) => {
      const roles: { id: string }[] = await app.db.query(
        'INSERT INTO roles (name) VALUES ($1) RETURNING id',
        [unique(label)],
      );
      await app.db.query(
        `INSERT INTO role_grants (role_id, permission_id, all_actions, actions)
         SELECT $1, id, false, $2::varchar[] FROM permissions WHERE name = $3`,
        [roles[0].id, actions, permission],
      );
      return roles[0].id;
    };
    userRole = await role('user', 'transformations', [
      'convert',
      'history',
      'download',
    ]);
    noDownloadRole = await role('nodl', 'transformations', [
      'convert',
      'history',
    ]);
    adminRole = await role('admin', 'transformations', ['download_any']);
    plainRole = await role('plain', 'users', ['read']);
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

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('POST /convert save flag', () => {
    it('save=false: no key, nothing staged, nothing stored, temp cleaned', async () => {
      const userId = await createUser('nosave', userRole);

      const res = await convert(userId, {
        targetFormat: 'json',
        save: 'false',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-save-status']).toBe('not_requested');
      expect(res.json()).toEqual(JSON_RESULT);
      const row = await rowOf(res.headers['x-transformation-id'] as string);
      expect(row).toMatchObject({
        storage_status: 'not_requested',
        stored_file_key: null,
        stored_file_until: null,
        storage_error_code: null,
      });
      expect(existsSync(join(storageDir, 'pending'))).toBe(false);
      expect(existsSync(join(storageDir, 'objects'))).toBe(false);
      await expectTempEmpty();

      // Not saved: nothing to download.
      const item = res.headers['x-transformation-id'] as string;
      expect((await download(userId, item)).statusCode).toBe(404);
    });

    it('the flag defaults to false', async () => {
      const userId = await createUser('default', userRole);
      const res = await convert(userId, { targetFormat: 'json' });
      expect(res.headers['x-save-status']).toBe('not_requested');
    });

    it.each(['maybe', 'TRUE', '1', ''])(
      '400 for save=%p (on both endpoints)',
      async (value) => {
        const userId = await createUser('badsave', userRole);
        expect(
          (await convert(userId, { targetFormat: 'json', save: value }))
            .statusCode,
        ).toBe(400);
        expect(
          (await convertImage(userId, { targetFormat: 'jpeg', save: value }))
            .statusCode,
        ).toBe(400);
      },
    );

    it('save=true: staged under a random key, pending, answers without waiting for storage', async () => {
      const userId = await createUser('save', userRole);

      const res = await convert(userId, { targetFormat: 'json', save: 'true' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-save-status']).toBe('pending');
      expect(res.headers['x-transformation-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.json()).toEqual(JSON_RESULT);
      const row = await rowOf(res.headers['x-transformation-id'] as string);
      expect(row.storage_status).toBe('pending');
      expect(row.stored_file_until).toBeNull();
      expect(row.storage_error_code).toBeNull();
      const key = row.stored_file_key as string;
      expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(key).not.toContain(userId);
      expect(key).not.toContain('private-name');
      expect(existsSync(join(storageDir, 'pending', key))).toBe(true);
      // Permanent storage is not touched by the request.
      expect(existsSync(join(storageDir, 'objects', key))).toBe(false);
      await expectTempEmpty();
    });

    it('a staging failure still returns the file; the row says error and has no key', async () => {
      const userId = await createUser('stagefail', userRole);
      jest
        .spyOn(StagingStore.prototype, 'stage')
        .mockRejectedValue(new Error('disk full'));

      const res = await convert(userId, { targetFormat: 'json', save: 'true' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-save-status']).toBe('error');
      expect(res.json()).toEqual(JSON_RESULT);
      const row = await rowOf(res.headers['x-transformation-id'] as string);
      expect(row).toMatchObject({
        storage_status: 'error',
        stored_file_key: null,
        storage_error_code: 'staging_failed',
      });
      const item = (await history(userId)).json().items[0];
      expect(item).toMatchObject({
        storageStatus: 'error',
        hasStoredFile: false,
        fileExpiresAt: null,
      });
      expect(JSON.stringify(item)).not.toContain('staging_failed');
    });

    it('a failed conversion with save=true stores nothing', async () => {
      const userId = await createUser('failconv', userRole);
      const { payload, contentType } = multipart(
        { targetFormat: 'json', save: 'true' },
        '{not csv at all\u0000',
      );
      const res = await app.inject({
        method: 'POST',
        url: '/convert',
        headers: { ...(await cookieOf(userId)), 'content-type': contentType },
        payload,
      });
      // Whatever the converter says, no copy is made for a failed attempt.
      const rows: Row[] = await app.db.query(
        'SELECT * FROM transformations WHERE user_id = $1',
        [userId],
      );
      if (res.statusCode !== 200) {
        expect(rows[0].storage_status).toBe('not_requested');
        expect(rows[0].stored_file_key).toBeNull();
      }
    });
  });

  describe('upload worker', () => {
    it('full flow: pending -> available, download works, history reflects it', async () => {
      const userId = await createUser('flow', userRole);
      const created = await convert(userId, {
        targetFormat: 'json',
        save: 'true',
      });
      const id = created.headers['x-transformation-id'] as string;
      const { stored_file_key: key } = await rowOf(id);

      // Still pending: listed, not downloadable yet.
      let item = (await history(userId)).json().items[0];
      expect(item).toMatchObject({
        id,
        storageStatus: 'pending',
        hasStoredFile: false,
        fileExpiresAt: null,
      });
      const early = await download(userId, id);
      expect(early.statusCode).toBe(409);
      expect(early.json().code).toBe('file_not_ready');

      const before = Date.now();
      const result = await worker.uploadPending();
      expect(result.uploaded).toBeGreaterThanOrEqual(1);

      const row = await rowOf(id);
      expect(row.storage_status).toBe('available');
      expect(row.stored_file_key).toBe(key);
      expect(row.storage_error_code).toBeNull();
      const days =
        (new Date(row.stored_file_until as Date).getTime() - before) /
        86_400_000;
      expect(days).toBeGreaterThan(89.9);
      expect(days).toBeLessThan(90.1);
      expect(existsSync(join(storageDir, 'pending', key as string))).toBe(
        false,
      );
      expect(existsSync(join(storageDir, 'objects', key as string))).toBe(true);

      item = (await history(userId)).json().items[0];
      expect(item).toMatchObject({
        id,
        storageStatus: 'available',
        hasStoredFile: true,
      });
      expect(item.fileExpiresAt).toBe(
        new Date(row.stored_file_until as Date).toISOString(),
      );
      const text = JSON.stringify(item);
      expect(text).not.toContain(key as string);
      expect(text).not.toMatch(/storedFileKey|stored_file_key|storageError/);

      const res = await download(userId, id);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/json');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="converted.json"',
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.json()).toEqual(JSON_RESULT);
    });

    it('is idempotent: a temporary failure keeps pending and the retry reuses the same key', async () => {
      const userId = await createUser('retry', userRole);
      const key = KEY('retry');
      await putStaged(key);
      const id = await seed(userId, 1, { status: 'pending', key });
      const save = jest
        .spyOn(LocalObjectStorage.prototype, 'save')
        .mockRejectedValueOnce(new StorageUnavailableError());

      expect((await worker.uploadPending()).retried).toBeGreaterThanOrEqual(1);
      expect((await rowOf(id)).storage_status).toBe('pending');
      expect(existsSync(join(storageDir, 'pending', key))).toBe(true);

      await worker.uploadPending();
      const row = await rowOf(id);
      expect(row.storage_status).toBe('available');
      expect(row.stored_file_key).toBe(key);
      expect(save.mock.calls.filter(([k]) => k === key)).toHaveLength(2);
      expect(existsSync(join(storageDir, 'objects', key))).toBe(true);

      // Another run changes nothing.
      const again = await worker.uploadPending();
      expect(again).toEqual({ uploaded: 0, failed: 0, retried: 0 });
    });

    it('an object left by a crashed run is simply replaced (same key)', async () => {
      const userId = await createUser('crash', userRole);
      const key = KEY('crash');
      await putObject(key, 'half-written-old');
      await putStaged(key, 'good-bytes');
      const id = await seed(userId, 2, { status: 'pending', key });

      await worker.uploadPending();

      expect((await rowOf(id)).storage_status).toBe('available');
      const res = await download(userId, id);
      expect(res.body).toBe('good-bytes');
    });

    it('a missing staged file is an error with a safe code, never shown in the API', async () => {
      const userId = await createUser('nostage', userRole);
      const key = KEY('nostage');
      const id = await seed(userId, 3, { status: 'pending', key });

      await worker.uploadPending();

      expect(await rowOf(id)).toMatchObject({
        storage_status: 'error',
        storage_error_code: 'staging_missing',
        stored_file_until: null,
      });
      const body = (await history(userId)).body;
      expect(body).toContain('"storageStatus":"error"');
      expect(body).not.toContain('staging_missing');
      expect((await download(userId, id)).statusCode).toBe(404);
    });

    it('a copy pending for too long becomes upload_timeout', async () => {
      const userId = await createUser('late', userRole);
      const key = KEY('late');
      await putStaged(key);
      const id = await seed(userId, 4, { status: 'pending', key });

      await worker.uploadPending(new Date(Date.now() + 2 * 3_600_000));

      expect(await rowOf(id)).toMatchObject({
        storage_status: 'error',
        storage_error_code: 'upload_timeout',
      });
      expect(existsSync(join(storageDir, 'pending', key))).toBe(false);
    });
  });

  describe('retention cleanup', () => {
    it('deletes expired files first, then clears the row; keeps unexpired ones', async () => {
      const userId = await createUser('expire', userRole);
      const oldKey = KEY('old');
      const freshKey = KEY('fresh');
      await putObject(oldKey);
      await putObject(freshKey);
      const old = await seed(userId, 10, {
        status: 'available',
        key: oldKey,
        until: new Date(Date.now() - 1000).toISOString(),
      });
      const fresh = await seed(userId, 11, {
        status: 'available',
        key: freshKey,
        until: new Date(Date.now() + 86_400_000).toISOString(),
      });

      const result = await worker.cleanupExpired();

      expect(result.deleted).toBeGreaterThanOrEqual(1);
      expect(existsSync(join(storageDir, 'objects', oldKey))).toBe(false);
      expect(await rowOf(old)).toMatchObject({
        storage_status: 'not_requested',
        stored_file_key: null,
        stored_file_until: null,
        storage_error_code: null,
      });
      expect((await rowOf(fresh)).storage_status).toBe('available');
      expect(existsSync(join(storageDir, 'objects', freshKey))).toBe(true);
    });

    it('an object that is already gone counts as deleted', async () => {
      const userId = await createUser('gone', userRole);
      const id = await seed(userId, 12, {
        status: 'available',
        key: KEY('gone'),
        until: new Date(Date.now() - 1000).toISOString(),
      });

      await worker.cleanupExpired();

      expect((await rowOf(id)).stored_file_key).toBeNull();
    });

    it('keeps the key when storage is unavailable, so the next run retries', async () => {
      const userId = await createUser('stuck', userRole);
      const key = KEY('stuck');
      await putObject(key);
      const id = await seed(userId, 13, {
        status: 'available',
        key,
        until: new Date(Date.now() - 1000).toISOString(),
      });
      jest
        .spyOn(LocalObjectStorage.prototype, 'delete')
        .mockResolvedValueOnce('unavailable');

      const first = await worker.cleanupExpired();
      expect(first.skipped).toBeGreaterThanOrEqual(1);
      expect((await rowOf(id)).stored_file_key).toBe(key);

      await worker.cleanupExpired();
      expect((await rowOf(id)).stored_file_key).toBeNull();
      expect(existsSync(join(storageDir, 'objects', key))).toBe(false);
    });

    it('an expired file is not offered and cannot be downloaded even before the cleanup', async () => {
      const userId = await createUser('lapsed', userRole);
      const key = KEY('lapsed');
      await putObject(key);
      const id = await seed(userId, 14, {
        status: 'available',
        key,
        until: new Date(Date.now() - 1000).toISOString(),
      });

      expect((await download(userId, id)).statusCode).toBe(404);
      const item = (await history(userId)).json().items[0];
      expect(item).toMatchObject({
        storageStatus: 'not_requested',
        hasStoredFile: false,
        fileExpiresAt: null,
      });
      await rm(join(storageDir, 'objects', key), { force: true });
    });
  });

  describe('user deletion', () => {
    it('removes the staged and the stored files of every record of the user', async () => {
      const userId = await createUser('erase', userRole);
      const stored = KEY('erase-stored');
      const staged = KEY('erase-staged');
      await putObject(stored);
      await putStaged(staged);
      await seed(userId, 20, {
        status: 'available',
        key: stored,
        until: new Date(Date.now() + 86_400_000).toISOString(),
      });
      await seed(userId, 21, { status: 'pending', key: staged });

      await expect(
        app.get(TransformationEraser).erase(userId),
      ).resolves.toEqual({ status: 'succeeded' });

      expect(existsSync(join(storageDir, 'objects', stored))).toBe(false);
      expect(existsSync(join(storageDir, 'pending', staged))).toBe(false);
      expect(
        await app.db.query('SELECT 1 FROM transformations WHERE user_id = $1', [
          userId,
        ]),
      ).toEqual([]);
    });

    it('keeps the rows (and their keys) while storage is unavailable', async () => {
      const userId = await createUser('erase-down', userRole);
      const key = KEY('erase-down');
      await putObject(key);
      await seed(userId, 22, {
        status: 'available',
        key,
        until: new Date(Date.now() + 86_400_000).toISOString(),
      });
      jest
        .spyOn(LocalObjectStorage.prototype, 'delete')
        .mockResolvedValueOnce('unavailable');

      const first = await app.get(TransformationEraser).erase(userId);
      expect(first.status).toBe('retryable_failure');
      expect(
        (
          await app.db.query(
            'SELECT 1 FROM transformations WHERE user_id = $1',
            [userId],
          )
        ).length,
      ).toBe(1);

      await expect(
        app.get(TransformationEraser).erase(userId),
      ).resolves.toEqual({ status: 'succeeded' });
      expect(existsSync(join(storageDir, 'objects', key))).toBe(false);
    });
  });

  describe('GET /transformations/history/:itemId/download', () => {
    let owner: string;
    let stranger: string;
    let itemId: string;

    beforeAll(async () => {
      owner = await createUser('dl-owner', userRole);
      stranger = await createUser('dl-stranger', userRole);
      const key = KEY('dl');
      await putObject(key, 'the-file');
      itemId = await seed(owner, 30, {
        status: 'available',
        key,
        until: new Date(Date.now() + 86_400_000).toISOString(),
      });
    });

    it('401 without a session, whether or not the item exists', async () => {
      expect((await download(undefined, itemId)).statusCode).toBe(401);
      expect((await download(undefined, rowId(999))).statusCode).toBe(401);
    });

    it('403 without transformations@download, identical for an unknown item (permission first)', async () => {
      const noDl = await createUser('dl-none', noDownloadRole);
      const plain = await createUser('dl-plain', plainRole);
      for (const as of [noDl, plain]) {
        const real = await download(as, itemId);
        const unknown = await download(as, rowId(998));
        expect(real.statusCode).toBe(403);
        expect(unknown.statusCode).toBe(403);
        expect(shape(real)).toEqual(shape(unknown));
      }
    });

    it('does not touch the database before the permission is checked', async () => {
      const noDl = await createUser('dl-nodb', noDownloadRole);
      const query = jest.spyOn(DataSource.prototype, 'query');
      const transaction = jest.spyOn(DataSource.prototype, 'transaction');
      const cookie = await cookieOf(noDl);
      query.mockClear();
      transaction.mockClear();
      await app.inject({
        method: 'GET',
        url: `/transformations/history/${itemId}/download`,
        headers: cookie,
      });
      const touched = [...query.mock.calls, ...transaction.mock.calls].some(
        (call) => String(call[0]).includes('FROM transformations'),
      );
      expect(touched).toBe(false);
    });

    it('streams the owner their file with the safe headers', async () => {
      const res = await download(owner, itemId);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('the-file');
      expect(res.headers['content-type']).toBe('application/json');
      expect(res.headers['content-length']).toBe(String('the-file'.length));
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="converted.json"',
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('IDOR: another user gets the same 404 as for an item that does not exist', async () => {
      const foreign = await download(stranger, itemId);
      const unknown = await download(stranger, rowId(997));
      expect(foreign.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(shape(foreign)).toEqual(shape(unknown));
    });

    it('404 for a malformed id', async () => {
      expect((await download(owner, 'not-a-uuid')).statusCode).toBe(404);
    });

    it('404 for an item that was not saved, failed, or is in error', async () => {
      const notSaved = await seed(owner, 31, { status: 'not_requested' });
      const failed = await seed(
        owner,
        32,
        { status: 'not_requested' },
        'error',
      );
      const broken = await seed(owner, 33, {
        status: 'error',
        error: 'staging_missing',
      });
      for (const id of [notSaved, failed, broken]) {
        expect((await download(owner, id)).statusCode).toBe(404);
      }
    });

    it('409 file_not_ready while pending', async () => {
      const id = await seed(owner, 34, {
        status: 'pending',
        key: KEY('dl-pending'),
      });
      const res = await download(owner, id);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('file_not_ready');
    });

    it('503 when the object is missing although the row has a key', async () => {
      const id = await seed(owner, 35, {
        status: 'available',
        key: KEY('dl-missing'),
        until: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const res = await download(owner, id);
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain(KEY('dl-missing'));
    });

    it('503 when the database is down', async () => {
      jest
        .spyOn(app.db, 'transaction')
        .mockRejectedValue(new Error('connection refused'));
      const res = await download(owner, itemId);
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain('connection refused');
    });

    it('audit log: user, transformation, action, size, outcome and duration; never keys, paths or names', async () => {
      const lines: Record<string, unknown>[] = [];
      jest.spyOn(Logger.prototype, 'log').mockImplementation((message) => {
        if (typeof message === 'object') {
          lines.push(message as Record<string, unknown>);
        }
      });
      jest.spyOn(Logger.prototype, 'warn').mockImplementation((message) => {
        if (typeof message === 'object') {
          lines.push(message as Record<string, unknown>);
        }
      });

      await download(owner, itemId);
      await download(stranger, itemId);

      const entries = lines.filter(
        (line) => line.event === 'transformation.stored_file.download',
      );
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        userId: owner,
        transformationId: itemId,
        action: 'download',
        outcome: 'success',
        size: 'the-file'.length,
      });
      expect(typeof entries[0].durationMs).toBe('number');
      expect(entries[1]).toMatchObject({
        action: 'download',
        outcome: 'not_found',
      });
      const text = JSON.stringify(lines);
      expect(text).not.toContain(KEY('dl'));
      expect(text).not.toContain(storageDir);
      expect(text).not.toContain('the-file');
      expect(text).not.toContain('access_token');
    });
  });

  describe('GET /admin/users/:userId/transformations/history/:itemId/download', () => {
    let owner: string;
    let admin: string;
    let regular: string;
    let itemId: string;

    beforeAll(async () => {
      owner = await createUser('adm-owner', userRole);
      admin = await createUser('adm-admin', adminRole);
      regular = await createUser('adm-regular', userRole);
      const key = KEY('adm');
      await putObject(key, 'admin-file');
      itemId = await seed(owner, 40, {
        status: 'available',
        key,
        until: new Date(Date.now() + 86_400_000).toISOString(),
      });
    });

    it('401 without a session', async () => {
      expect((await adminDownload(undefined, owner, itemId)).statusCode).toBe(
        401,
      );
    });

    it('403 without download_any, even for the owner of the file, and for an unknown user (permission first)', async () => {
      const own = await adminDownload(owner, owner, itemId);
      const probe = await adminDownload(regular, rowId(996), itemId);
      expect(own.statusCode).toBe(403);
      expect(probe.statusCode).toBe(403);
      expect(shape(own)).toEqual(shape(probe));
    });

    it("streams any user's file to an administrator", async () => {
      const res = await adminDownload(admin, owner, itemId);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('admin-file');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="converted.json"',
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('404 for an unknown user, a malformed user id, and an item of another user', async () => {
      expect((await adminDownload(admin, rowId(995), itemId)).statusCode).toBe(
        404,
      );
      expect((await adminDownload(admin, 'nope', itemId)).statusCode).toBe(404);
      // The item exists, but not under this user.
      expect((await adminDownload(admin, regular, itemId)).statusCode).toBe(
        404,
      );
    });

    it('applies the same status rules as the own download', async () => {
      const pending = await seed(owner, 41, {
        status: 'pending',
        key: KEY('adm-pending'),
      });
      const notSaved = await seed(owner, 42, { status: 'not_requested' });
      const expired = await seed(owner, 43, {
        status: 'available',
        key: KEY('adm-expired'),
        until: new Date(Date.now() - 1000).toISOString(),
      });
      const missing = await seed(owner, 44, {
        status: 'available',
        key: KEY('adm-missing'),
        until: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const pendingRes = await adminDownload(admin, owner, pending);
      expect(pendingRes.statusCode).toBe(409);
      expect(pendingRes.json().code).toBe('file_not_ready');
      expect((await adminDownload(admin, owner, notSaved)).statusCode).toBe(
        404,
      );
      expect((await adminDownload(admin, owner, expired)).statusCode).toBe(404);
      expect((await adminDownload(admin, owner, missing)).statusCode).toBe(503);
    });

    it('audit log names the administrator as the actor', async () => {
      const lines: Record<string, unknown>[] = [];
      jest.spyOn(Logger.prototype, 'log').mockImplementation((message) => {
        if (typeof message === 'object') {
          lines.push(message as Record<string, unknown>);
        }
      });
      await adminDownload(admin, owner, itemId);
      expect(
        lines.find((l) => l.event === 'transformation.stored_file.download'),
      ).toMatchObject({
        userId: owner,
        actorUserId: admin,
        action: 'download',
        outcome: 'success',
      });
    });
  });

  describe('image endpoint', () => {
    it('save=true is accepted and reports the status header', async () => {
      const userId = await createUser('img', userRole);
      const res = await convertImage(userId, {
        targetFormat: 'jpeg',
        save: 'true',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-save-status']).toBe('pending');
      await worker.uploadPending();
      const id = res.headers['x-transformation-id'] as string;
      const file = await download(userId, id);
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-type']).toBe('image/jpeg');
      expect(file.headers['content-disposition']).toBe(
        'attachment; filename="converted.jpeg"',
      );
    });
  });
});
