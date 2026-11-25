/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument,@typescript-eslint/no-unsafe-return */
import { ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { AppModule } from '../src/core/app/app.module';
import { ConfigService } from '../src/core/config/config.service';
import { ProblemDetailsExceptionFilter } from '../src/modules/auth/errors/problem-details-exception.filter';
import { MailService } from '../src/modules/auth/services/mail.service';
import { TokenService } from '../src/modules/auth/services/token.service';
import { HistoryRetentionWorker } from '../src/modules/transformations/services/history-retention.worker';

// Must not start with "e2e-" (the registration e2e deletes 'e2e-%' users).
const PREFIX = 'thistory-spec';
const DOMAIN = '@example.test';
const RUN = Date.now();
let counter = 0;
const unique = (label: string) =>
  `${PREFIX}-${RUN}-${label}-${counter++}`.toLowerCase();

type TestApp = NestFastifyApplication & { db: DataSource };
let transactionalReady = false;

interface Seed {
  id: string;
  createdAt: string;
  type?: 'file' | 'image';
  source?: string;
  target?: string;
  status?: 'success' | 'error';
}

/** Fixed ids, so ordering assertions do not depend on random uuids. */
const rowId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface Page {
  items: Record<string, any>[];
  nextCursor: string | null;
}

describe('Transformation history (e2e)', () => {
  let app: TestApp;
  let tempDir: string;
  let storageDir: string;
  let historyRole: string;
  let anyRole: string;
  let plainRole: string;

  const env = (overrides: Record<string, string> = {}) => ({
    REGISTRATION_CONFIRMATION_ENABLED: 'false',
    API_PUBLIC_URL: 'https://api.test',
    STORAGE_CLEANUP_WORKER_ENABLED: 'false',
    DELETION_WORKER_ENABLED: 'false',
    TRANSFORM_HISTORY_CLEANUP_ENABLED: 'false',
    TRANSFORM_HISTORY_RATE_LIMIT: '1000',
    TRANSFORM_TEMP_DIR: tempDir,
    TRANSFORM_STORAGE_DIR: storageDir,
    PHOTO_STORAGE_DIR: join(storageDir, 'photos'),
    ...overrides,
  });

  async function createApp(
    overrides: Record<string, string> = {},
  ): Promise<TestApp> {
    if (!transactionalReady) {
      initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });
      transactionalReady = true;
    }
    const values = env(overrides);
    const config = { get: (key: string) => values[key] ?? process.env[key] };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(MailService)
      .useValue({})
      .compile();
    const created = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ routerOptions: { maxParamLength: 256 } }),
    ) as TestApp;
    created.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    created.useGlobalFilters(new ProblemDetailsExceptionFilter());
    await created.init();
    await created.getHttpAdapter().getInstance().ready();
    created.db = created.get(DataSource);
    return created;
  }

  const bump = () =>
    app.db.query(
      'UPDATE rbac_policy_state SET version = version + 1 WHERE id = 1',
    );

  async function createUser(
    label: string,
    role: string,
    status = 'active',
  ): Promise<{ id: string; email: string }> {
    const email = `${unique(label)}${DOMAIN}`;
    const rows: { id: string }[] = await app.db.query(
      `INSERT INTO users (email, password_hash, status)
       VALUES ($1, 'x-hash', $2) RETURNING id`,
      [email, status],
    );
    await app.db.query(
      'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
      [rows[0].id, role],
    );
    await bump();
    return { id: rows[0].id, email };
  }

  async function seed(userId: string, rows: Seed[]): Promise<void> {
    for (const row of rows) {
      const status = row.status ?? 'success';
      await app.db.query(
        `INSERT INTO transformations
           (id, user_id, type, source_format, target_format, status, input_size,
            output_size, duration_ms, error_code, created_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, 100, $7, 12, $8, $9::timestamptz, $9::timestamptz)`,
        [
          row.id,
          userId,
          row.type ?? 'file',
          row.source ?? 'csv',
          row.target ?? 'json',
          status,
          status === 'success' ? 250 : null,
          status === 'error' ? 'conversion_failed' : null,
          row.createdAt,
        ],
      );
    }
  }

  async function cookieOf(userId?: string): Promise<Record<string, string>> {
    if (!userId) return {};
    const { access } = await app
      .get(TokenService, { strict: false })
      .issuePair(userId);
    return { cookie: `access_token=${access}` };
  }

  const getSelf = async (as?: string, query = '', target: TestApp = app) =>
    target.inject({
      method: 'GET',
      url: `/transformations/history${query}`,
      headers: await cookieOf(as),
    });

  const getAdmin = async (
    as: string | undefined,
    userId: string,
    query = '',
    target: TestApp = app,
  ) =>
    target.inject({
      method: 'GET',
      url: `/admin/users/${userId}/transformations/history${query}`,
      headers: await cookieOf(as),
    });

  const page = (res: { body: string }): Page => JSON.parse(res.body) as Page;

  /** Follows `nextCursor` to the end; returns every id in order. */
  async function walk(
    fetch: (query: string) => Promise<{ statusCode: number; body: string }>,
    query: string,
  ): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const res = await fetch(
        cursor ? `${query}&cursor=${encodeURIComponent(cursor)}` : query,
      );
      expect(res.statusCode).toBe(200);
      const body = page(res);
      ids.push(...body.items.map((item) => item.id as string));
      cursor = body.nextCursor;
      if (!cursor) return ids;
    }
    throw new Error('pagination did not terminate');
  }

  let owner: { id: string; email: string };
  let other: { id: string; email: string };
  let reader: { id: string; email: string };
  let admin: { id: string; email: string };
  let plain: { id: string; email: string };
  let empty: { id: string; email: string };

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'thistory-temp-'));
    storageDir = await mkdtemp(join(tmpdir(), 'thistory-store-'));
    app = await createApp();

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
    historyRole = await role('history', 'transformations', ['history']);
    anyRole = await role('any', 'transformations', ['history_any']);
    plainRole = await role('plain', 'users', ['read']);
    await bump();

    owner = await createUser('owner', historyRole);
    other = await createUser('other', historyRole);
    reader = await createUser('reader', historyRole);
    admin = await createUser('admin', anyRole);
    plain = await createUser('plain', plainRole);
    empty = await createUser('empty', historyRole);

    // Three rows share one created_at: only `id DESC` orders them.
    const TIE = '2026-03-01T10:00:00.123456Z';
    await seed(owner.id, [
      { id: rowId(1), createdAt: '2026-03-01T09:00:00Z', status: 'error' },
      { id: rowId(2), createdAt: TIE },
      {
        id: rowId(3),
        createdAt: TIE,
        type: 'image',
        source: 'png',
        target: 'jpeg',
      },
      { id: rowId(4), createdAt: TIE, status: 'error' },
      {
        id: rowId(5),
        createdAt: '2026-03-02T10:00:00Z',
        type: 'image',
        source: 'jpeg',
        target: 'png',
      },
      { id: rowId(6), createdAt: '2026-03-03T10:00:00Z' },
    ]);
    await seed(other.id, [
      { id: rowId(101), createdAt: '2026-03-10T10:00:00Z' },
      { id: rowId(102), createdAt: '2026-03-11T10:00:00Z' },
    ]);
    // One of the owner's rows has a stored file: its key must not leak.
    await app.db.query(
      `UPDATE transformations SET storage_status = 'available',
         stored_file_key = 'SECRET-STORAGE-KEY-0123456789',
         stored_file_until = '2999-01-01T00:00:00Z'
       WHERE id = $1`,
      [rowId(6)],
    );
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

  describe('GET /transformations/history (self)', () => {
    it('401 without a session', async () => {
      expect((await getSelf()).statusCode).toBe(401);
    });

    it('403 without transformations@history', async () => {
      expect((await getSelf(plain.id)).statusCode).toBe(403);
      // history_any alone is not history.
      expect((await getSelf(admin.id)).statusCode).toBe(403);
    });

    it("returns only the caller's rows, newest first, with the full contract", async () => {
      const res = await getSelf(owner.id);
      expect(res.statusCode).toBe(200);
      const body = page(res);
      expect(body.nextCursor).toBeNull();
      expect(body.items.map((i) => i.id)).toEqual([
        rowId(6),
        rowId(5),
        rowId(4),
        rowId(3),
        rowId(2),
        rowId(1),
      ]);
      expect(body.items[0]).toEqual({
        id: rowId(6),
        type: 'file',
        sourceFormat: 'csv',
        targetFormat: 'json',
        status: 'success',
        inputSize: 100,
        outputSize: 250,
        durationMs: 12,
        errorCode: null,
        createdAt: '2026-03-03T10:00:00.000Z',
        storageStatus: 'available',
        hasStoredFile: true,
        fileExpiresAt: '2999-01-01T00:00:00.000Z',
      });
      expect(body.items[2]).toMatchObject({
        status: 'error',
        outputSize: null,
        errorCode: 'conversion_failed',
      });
    });

    it('never exposes the user id, e-mail or storage key', async () => {
      const text = (await getSelf(owner.id)).body;
      expect(text).not.toContain(owner.id);
      expect(text).not.toContain(owner.email);
      expect(text).not.toMatch(/userId|user_id|email|SECRET|storageKey/);
    });

    it('takes the user from the session, never from the query', async () => {
      const res = await getSelf(owner.id, `?userId=${other.id}`);
      expect(res.statusCode).toBe(400);
      const mine = await getSelf(other.id);
      expect(page(mine).items.map((i) => i.id)).toEqual([
        rowId(102),
        rowId(101),
      ]);
    });

    it('an empty history is an empty page', async () => {
      const res = await getSelf(empty.id);
      expect(res.statusCode).toBe(200);
      expect(page(res)).toEqual({ items: [], nextCursor: null });
    });

    describe('pagination', () => {
      it('orders rows of one created_at by id DESC across pages, without gaps or repeats', async () => {
        const ids = await walk((q) => getSelf(owner.id, q), '?limit=2');
        expect(ids).toEqual([
          rowId(6),
          rowId(5),
          rowId(4),
          rowId(3),
          rowId(2),
          rowId(1),
        ]);
      });

      it('splits a page inside the identical-created_at group', async () => {
        const first = page(await getSelf(owner.id, '?limit=3'));
        expect(first.items.map((i) => i.id)).toEqual([
          rowId(6),
          rowId(5),
          rowId(4),
        ]);
        expect(first.nextCursor).not.toBeNull();
        const second = page(
          await getSelf(
            owner.id,
            `?limit=3&cursor=${encodeURIComponent(first.nextCursor as string)}`,
          ),
        );
        expect(second.items.map((i) => i.id)).toEqual([
          rowId(3),
          rowId(2),
          rowId(1),
        ]);
        expect(second.nextCursor).toBeNull();
      });

      it('has no nextCursor when exactly limit rows remain', async () => {
        const res = page(await getSelf(owner.id, '?limit=6'));
        expect(res.items).toHaveLength(6);
        expect(res.nextCursor).toBeNull();
      });

      it('the cursor is base64url and holds version, position and canonical query', async () => {
        const { nextCursor } = page(
          await getSelf(owner.id, '?limit=2&type=file'),
        );
        expect(nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
        const payload = JSON.parse(
          Buffer.from(nextCursor as string, 'base64url').toString(),
        );
        expect(payload).toEqual({
          v: 1,
          createdAt: '2026-03-01T10:00:00.123456Z',
          id: rowId(4),
          q: {
            limit: 2,
            type: 'file',
            sourceFormat: null,
            targetFormat: null,
            status: null,
            createdAtFrom: null,
            createdAtTo: null,
          },
        });
      });

      it('400 when the limit or a filter differs from the cursor', async () => {
        const { nextCursor } = page(await getSelf(owner.id, '?limit=2'));
        const cursor = encodeURIComponent(nextCursor as string);
        expect(
          (await getSelf(owner.id, `?limit=3&cursor=${cursor}`)).statusCode,
        ).toBe(400);
        expect((await getSelf(owner.id, `?cursor=${cursor}`)).statusCode).toBe(
          400,
        );
        expect(
          (await getSelf(owner.id, `?limit=2&status=error&cursor=${cursor}`))
            .statusCode,
        ).toBe(400);
        const ok = await getSelf(owner.id, `?limit=2&cursor=${cursor}`);
        expect(ok.statusCode).toBe(200);
      });

      it.each([
        ['garbage', 'not-a-cursor!'],
        ['not json', Buffer.from('hello').toString('base64url')],
        [
          'unknown version',
          Buffer.from(
            JSON.stringify({
              v: 9,
              createdAt: '2026-03-01T10:00:00.123456Z',
              id: rowId(4),
              q: {},
            }),
          ).toString('base64url'),
        ],
      ])('400 invalid_cursor for a %s cursor', async (_name, cursor) => {
        const res = await getSelf(
          owner.id,
          `?cursor=${encodeURIComponent(cursor)}`,
        );
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).code).toBe('invalid_cursor');
      });

      it('400 for a tampered position that no longer matches the structure', async () => {
        const { nextCursor } = page(await getSelf(owner.id, '?limit=2'));
        const payload = JSON.parse(
          Buffer.from(nextCursor as string, 'base64url').toString(),
        );
        payload.id = 'not-a-uuid';
        const res = await getSelf(
          owner.id,
          `?limit=2&cursor=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`,
        );
        expect(res.statusCode).toBe(400);
      });

      it("another user's cursor can only move within the caller's own rows", async () => {
        const { nextCursor } = page(await getSelf(owner.id, '?limit=2'));
        const res = page(
          await getSelf(
            other.id,
            `?limit=2&cursor=${encodeURIComponent(nextCursor as string)}`,
          ),
        );
        expect(
          res.items.every((i) => [rowId(101), rowId(102)].includes(i.id)),
        ).toBe(true);
      });
    });

    describe('filters', () => {
      const idsOf = async (query: string) =>
        page(await getSelf(owner.id, query)).items.map((i) => i.id);

      it('type', async () => {
        expect(await idsOf('?type=image')).toEqual([rowId(5), rowId(3)]);
        expect(await idsOf('?type=file')).toEqual([
          rowId(6),
          rowId(4),
          rowId(2),
          rowId(1),
        ]);
      });

      it('status', async () => {
        expect(await idsOf('?status=error')).toEqual([rowId(4), rowId(1)]);
        expect(await idsOf('?status=success')).toEqual([
          rowId(6),
          rowId(5),
          rowId(3),
          rowId(2),
        ]);
      });

      it('sourceFormat and targetFormat (case-insensitive)', async () => {
        expect(await idsOf('?sourceFormat=png')).toEqual([rowId(3)]);
        expect(await idsOf('?sourceFormat=PNG')).toEqual([rowId(3)]);
        expect(await idsOf('?targetFormat=png')).toEqual([rowId(5)]);
        expect(await idsOf('?sourceFormat=jpeg&targetFormat=png')).toEqual([
          rowId(5),
        ]);
      });

      it('createdAtFrom is inclusive and createdAtTo is exclusive', async () => {
        expect(await idsOf('?createdAtFrom=2026-03-02T10:00:00Z')).toEqual([
          rowId(6),
          rowId(5),
        ]);
        expect(await idsOf('?createdAtTo=2026-03-02T10:00:00Z')).toEqual([
          rowId(4),
          rowId(3),
          rowId(2),
          rowId(1),
        ]);
        expect(
          await idsOf(
            '?createdAtFrom=2026-03-02T10:00:00Z&createdAtTo=2026-03-03T10:00:00Z',
          ),
        ).toEqual([rowId(5)]);
      });

      it('accepts an offset and compares in UTC', async () => {
        const encoded = encodeURIComponent('2026-03-02T12:00:00+02:00');
        expect(await idsOf(`?createdAtFrom=${encoded}`)).toEqual([
          rowId(6),
          rowId(5),
        ]);
      });

      it('combines filters, and paginates inside a filtered set', async () => {
        expect(
          await idsOf(
            '?type=file&status=error&createdAtTo=2026-03-02T00:00:00Z',
          ),
        ).toEqual([rowId(4), rowId(1)]);
        const ids = await walk(
          (q) => getSelf(owner.id, q),
          '?type=file&limit=3',
        );
        expect(ids).toEqual([rowId(6), rowId(4), rowId(2), rowId(1)]);
      });

      it('a filter without matches is an empty page', async () => {
        expect(await idsOf('?createdAtFrom=2030-01-01T00:00:00Z')).toEqual([]);
      });
    });

    describe('validation (400)', () => {
      it.each([
        ['limit 0', '?limit=0'],
        ['limit 101 (not clamped)', '?limit=101'],
        ['limit not a number', '?limit=abc'],
        ['repeated limit', '?limit=1&limit=2'],
        ['unknown type', '?type=video'],
        ['unknown status', '?status=pending'],
        ['unsupported source format', '?sourceFormat=docx'],
        ['unsupported target format', '?targetFormat=docx'],
        ['date without a zone', '?createdAtFrom=2026-03-01T00:00:00'],
        ['impossible date', '?createdAtFrom=2026-02-30T00:00:00Z'],
        [
          'createdAtFrom equal to createdAtTo',
          '?createdAtFrom=2026-03-01T00:00:00Z&createdAtTo=2026-03-01T00:00:00Z',
        ],
        [
          'createdAtFrom after createdAtTo',
          '?createdAtFrom=2026-03-02T00:00:00Z&createdAtTo=2026-03-01T00:00:00Z',
        ],
        ['unknown parameter', '?offset=10'],
      ])('%s', async (_name, query) => {
        const res = await getSelf(owner.id, query);
        expect(res.statusCode).toBe(400);
        expect(res.headers['content-type']).toContain(
          'application/problem+json',
        );
      });

      it('accepts the limit bounds 1 and 100', async () => {
        expect(page(await getSelf(owner.id, '?limit=1')).items).toHaveLength(1);
        expect((await getSelf(owner.id, '?limit=100')).statusCode).toBe(200);
      });

      it('401/403 win over validation errors', async () => {
        expect((await getSelf(undefined, '?limit=0')).statusCode).toBe(401);
        expect((await getSelf(plain.id, '?limit=0')).statusCode).toBe(403);
      });
    });
  });

  describe('GET /admin/users/:userId/transformations/history', () => {
    it('401 without a session', async () => {
      expect((await getAdmin(undefined, owner.id)).statusCode).toBe(401);
    });

    it('403 for a user with only transformations@history', async () => {
      expect((await getAdmin(reader.id, owner.id)).statusCode).toBe(403);
    });

    it('403 (not 404) for an unauthorized caller asking about a user that does not exist', async () => {
      const missing = '99999999-9999-4999-8999-999999999999';
      expect((await getAdmin(reader.id, missing)).statusCode).toBe(403);
      expect((await getAdmin(plain.id, missing)).statusCode).toBe(403);
      expect((await getAdmin(reader.id, 'not-a-uuid')).statusCode).toBe(403);
    });

    it('404 for an authorized caller and an unknown user', async () => {
      const missing = '99999999-9999-4999-8999-999999999999';
      const res = await getAdmin(admin.id, missing);
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).code).toBe('not_found');
      expect((await getAdmin(admin.id, 'not-a-uuid')).statusCode).toBe(404);
    });

    it("returns the target user's history with the same contract", async () => {
      const res = await getAdmin(admin.id, owner.id, '?limit=2');
      expect(res.statusCode).toBe(200);
      const body = page(res);
      expect(body.items.map((i) => i.id)).toEqual([rowId(6), rowId(5)]);
      expect(body.items[0]).toMatchObject({
        storageStatus: 'available',
        hasStoredFile: true,
        fileExpiresAt: '2999-01-01T00:00:00.000Z',
      });
      expect(res.body).not.toContain(owner.email);
      expect(res.body).not.toContain('SECRET');
      expect(body.nextCursor).not.toBeNull();
    });

    it('walks all pages and applies filters', async () => {
      const ids = await walk(
        (q) => getAdmin(admin.id, owner.id, q),
        '?limit=4',
      );
      expect(ids).toHaveLength(6);
      const images = page(await getAdmin(admin.id, owner.id, '?type=image'));
      expect(images.items.map((i) => i.id)).toEqual([rowId(5), rowId(3)]);
    });

    it('400 for an invalid query, even for an existing user', async () => {
      expect(
        (await getAdmin(admin.id, owner.id, '?limit=500')).statusCode,
      ).toBe(400);
      expect(
        (await getAdmin(admin.id, owner.id, '?cursor=garbage')).statusCode,
      ).toBe(400);
    });

    it('an existing user with no history is an empty page', async () => {
      expect(page(await getAdmin(admin.id, empty.id))).toEqual({
        items: [],
        nextCursor: null,
      });
    });

    it('the session user cannot be swapped through the path on the self route', async () => {
      // /transformations/history has no :userId; the admin cannot read it as a user.
      expect((await getSelf(admin.id)).statusCode).toBe(403);
    });
  });

  describe('rate limit', () => {
    let limited: TestApp;
    beforeAll(async () => {
      limited = await createApp({
        TRANSFORM_HISTORY_RATE_LIMIT: '3',
        TRANSFORM_HISTORY_RATE_WINDOW_MS: '60000',
      });
    });
    afterAll(async () => {
      await limited.close();
    });

    it('answers 429 with Retry-After semantics after the limit, per user', async () => {
      const results: number[] = [];
      for (let i = 0; i < 4; i++) {
        results.push((await getSelf(other.id, '', limited)).statusCode);
      }
      expect(results).toEqual([200, 200, 200, 429]);
      const refused = await getSelf(other.id, '', limited);
      expect(refused.statusCode).toBe(429);
      expect(JSON.parse(refused.body).retryAfterSeconds).toBeGreaterThan(0);
      // Another user has their own bucket.
      expect((await getSelf(reader.id, '', limited)).statusCode).toBe(200);
    });

    it('the self and the administrator routes share the actor bucket', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push(
          (await getAdmin(admin.id, owner.id, '', limited)).statusCode,
        );
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
    });

    it('requests refused by authorization are not counted', async () => {
      for (let i = 0; i < 5; i++) {
        expect(
          (await getAdmin(plain.id, owner.id, '', limited)).statusCode,
        ).toBe(403);
      }
      expect((await getSelf(empty.id, '', limited)).statusCode).toBe(200);
    });
  });

  describe('retention cleanup', () => {
    let worker: HistoryRetentionWorker;
    let victim: { id: string; email: string };
    // Year-2001 rows and a fixed "now": the job can never touch real data.
    const NOW = new Date('2001-06-01T00:00:00Z');

    beforeAll(async () => {
      worker = app.get(HistoryRetentionWorker);
      victim = await createUser('victim', historyRole);
    });

    const exists = async (id: string) =>
      (await app.db.query('SELECT 1 FROM transformations WHERE id = $1', [id]))
        .length > 0;

    const markStored = (id: string, key: string) =>
      app.db.query(
        `UPDATE transformations SET storage_status = 'available',
           stored_file_key = $2, stored_file_until = '2999-01-01T00:00:00Z'
         WHERE id = $1`,
        [id, key],
      );

    it('deletes rows older than 90 days (with their stored file) and keeps newer ones', async () => {
      const key = `retention-key-${RUN}-aaaaaaaaaaaa`;
      await mkdir(join(storageDir, 'objects'), { recursive: true });
      await writeFile(join(storageDir, 'objects', key), 'data');

      await seed(victim.id, [
        { id: rowId(201), createdAt: '2001-01-01T00:00:00Z' }, // 151 days old
        { id: rowId(202), createdAt: '2001-02-01T00:00:00Z' }, // 120 days old, stored file
        { id: rowId(203), createdAt: '2001-03-15T00:00:00Z' }, // 78 days old: kept
      ]);
      await markStored(rowId(202), key);

      const result = await worker.run(NOW);

      expect(result).toEqual({ deleted: 2, skipped: 0 });
      expect(await exists(rowId(201))).toBe(false);
      expect(await exists(rowId(202))).toBe(false);
      expect(await exists(rowId(203))).toBe(true);
      expect(existsSync(join(storageDir, 'objects', key))).toBe(false);
    });

    it('treats a stored file that is already gone as cleaned', async () => {
      await seed(victim.id, [
        { id: rowId(204), createdAt: '2001-01-02T00:00:00Z' },
      ]);
      await markStored(rowId(204), `retention-missing-${RUN}-bbbbbbbbbbbb`);
      await expect(worker.run(NOW)).resolves.toEqual({
        deleted: 1,
        skipped: 0,
      });
      expect(await exists(rowId(204))).toBe(false);
    });

    it('a deleted row no longer appears in the history', async () => {
      const ids = page(await getSelf(victim.id)).items.map((i) => i.id);
      expect(ids).toEqual([rowId(203)]);
    });
  });
});
