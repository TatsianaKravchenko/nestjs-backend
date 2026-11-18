/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import { ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
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

// Must not start with "e2e-" (the registration e2e deletes 'e2e-%' users).
const PREFIX = 'adminlist-spec';
const DOMAIN = '@example.test';
const RUN = Date.now();
const SECRET_HASH = 'x-secret-password-hash';
const PHOTO_KEY_PREFIX = 'secret-photo-key';
const KEY = 'k'.repeat(40);
const GOOD_ENV = {
  USER_LIST_CURSOR_ACTIVE_KEY_ID: 'k1',
  USER_LIST_CURSOR_HMAC_KEYS: `k1:${KEY}`,
};
let counter = 0;
const unique = (label: string) =>
  `${PREFIX}-${RUN}-${label}-${counter++}`.toLowerCase();

type TestApp = NestFastifyApplication & { db: DataSource };
let transactionalReady = false;

async function createApp(
  overrides: Record<string, string> = {},
): Promise<TestApp> {
  if (!transactionalReady) {
    initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });
    transactionalReady = true;
  }
  const env: Record<string, string> = {
    REGISTRATION_CONFIRMATION_ENABLED: 'false',
    API_PUBLIC_URL: 'https://api.test',
    ADMIN_USERS_LIST_WINDOW_MS: '60000',
    ADMIN_USERS_LIST_ACTOR_LIMIT: '60',
    ADMIN_USERS_LIST_IP_LIMIT: '120',
    ...GOOD_ENV,
    ...overrides,
  };
  const config = { get: (key: string) => env[key] ?? process.env[key] };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ConfigService)
    .useValue(config)
    .overrideProvider(MailService)
    .useValue({
      sendRegistrationOtp: () => Promise.resolve(),
      sendRegistrationMagicLink: () => Promise.resolve(),
    })
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ routerOptions: { maxParamLength: 256 } }),
  ) as TestApp;
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.useGlobalFilters(new ProblemDetailsExceptionFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  app.db = app.get(DataSource);
  return app;
}

describe('Admin users list (e2e)', () => {
  let app: TestApp;
  let admin: string; // users@list
  let readAnyOnly: string; // users@read + users@read_any, no list
  let noPerms: string;
  let blockedAdmin: string; // users@list but status blocked

  const bump = () =>
    app.db.query(
      'UPDATE rbac_policy_state SET version = version + 1 WHERE id = 1',
    );

  async function createUser(
    label: string,
    options: {
      status?: string;
      displayName?: string | null;
      photo?: boolean;
      createdAt?: string;
      roles?: string[];
    } = {},
  ): Promise<{ id: string; email: string }> {
    const status = options.status ?? 'active';
    const erased = status === 'deleted';
    const email = `${unique(label)}${DOMAIN}`;
    const rows: { id: string }[] = await app.db.query(
      `INSERT INTO users (email, password_hash, status, display_name, photo_key, created_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now())) RETURNING id`,
      [
        email,
        SECRET_HASH,
        status,
        erased
          ? null
          : options.displayName === undefined
            ? 'Jane Doe'
            : options.displayName,
        options.photo && !erased ? `${PHOTO_KEY_PREFIX}-${unique('p')}` : null,
        options.createdAt ?? null,
      ],
    );
    for (const roleId of options.roles ?? []) {
      await app.db.query(
        'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
        [rows[0].id, roleId],
      );
    }
    if (options.roles?.length) await bump();
    return { id: rows[0].id, email };
  }

  const createRole = async (label: string, actions: string[]) => {
    const roles: { id: string }[] = await app.db.query(
      'INSERT INTO roles (name) VALUES ($1) RETURNING id',
      [unique(label)],
    );
    await app.db.query(
      `INSERT INTO role_grants (role_id, permission_id, all_actions, actions)
       SELECT $1, id, false, $2::varchar[] FROM permissions WHERE name = 'users'`,
      [roles[0].id, actions],
    );
    return roles[0].id;
  };

  async function cookieFor(userId: string, target: TestApp = app) {
    const { access } = await target
      .get(TokenService, { strict: false })
      .issuePair(userId);
    return `access_token=${access}`;
  }

  async function list(
    query: string,
    as?: string,
    target: TestApp = app,
    headers: Record<string, string> = {},
  ) {
    const cookie = as ? await cookieFor(as, target) : undefined;
    return target.inject({
      method: 'GET',
      url: `/admin/users${query}`,
      headers: { ...(cookie ? { cookie } : {}), ...headers },
    });
  }

  /** All pages of a query as `admin`, following `nextCursor`. */
  async function drain(query: string, limit: number) {
    const pages: any[][] = [];
    let cursor: string | null = null;
    do {
      const res = await list(
        `?${query}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
        admin,
      );
      expect(res.statusCode).toBe(200);
      pages.push(res.json().items);
      cursor = res.json().nextCursor;
    } while (cursor);
    return pages;
  }

  beforeAll(async () => {
    app = await createApp();
    await app.db.query(
      `INSERT INTO permissions (name, actions)
       VALUES ('users', '{read,read_any,update,delete,list}')
       ON CONFLICT (name) DO UPDATE SET actions = (
         SELECT array_agg(DISTINCT a) FROM unnest(permissions.actions || '{read,read_any,list}'::varchar[]) a
       )`,
    );
    const listRole = await createRole('lister', ['list']);
    const readAnyRole = await createRole('read-any', ['read', 'read_any']);
    admin = (await createUser('admin', { roles: [listRole] })).id;
    blockedAdmin = (
      await createUser('blocked-admin', {
        roles: [listRole],
        status: 'blocked',
      })
    ).id;
    readAnyOnly = (await createUser('read-any', { roles: [readAnyRole] })).id;
    noPerms = (await createUser('noperms')).id;
    await bump();
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app.db.query(
      `DELETE FROM user_roles WHERE user_id IN
         (SELECT id FROM users WHERE email LIKE '${PREFIX}-%${DOMAIN}')`,
    );
    await app.db.query(
      `DELETE FROM role_grants WHERE role_id IN
         (SELECT id FROM roles WHERE name LIKE '${PREFIX}-%')`,
    );
    await app.db.query(`DELETE FROM roles WHERE name LIKE '${PREFIX}-%'`);
    await app.db.query(
      `DELETE FROM users WHERE email LIKE '${PREFIX}-%${DOMAIN}'`,
    );
    await bump();
    await app.close();
  });

  describe('authentication and authorization', () => {
    it('401 without a cookie', async () => {
      const res = await list('');
      expect(res.statusCode).toBe(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
    });

    it('401 for a garbage cookie', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/users',
        headers: { cookie: 'access_token=nope' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('401 when the actor is not active in the DB', async () => {
      expect((await list('', blockedAdmin)).statusCode).toBe(401);
    });

    it('403 without users@list, whatever the role', async () => {
      expect((await list('', noPerms)).statusCode).toBe(403);
      // read + read_any is not enough: the per-row permission is never consulted
      expect((await list('', readAnyOnly)).statusCode).toBe(403);
    });

    it('403 comes before query validation (an invalid query leaks nothing)', async () => {
      const res = await list('?limit=9999&foo=1&cursor=x', noPerms);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('permission_denied');
    });

    it('does not read the users table for a caller without users@list', async () => {
      const spy = jest.spyOn(app.db, 'transaction');
      await list('?limit=5', noPerms);
      expect(spy).not.toHaveBeenCalled();
    });

    it('200 with users@list', async () => {
      const res = await list('?limit=1', admin);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('query validation (400)', () => {
    it.each([
      ['unknown parameter', '?foo=bar'],
      ['duplicate limit', '?limit=1&limit=2'],
      ['duplicate sort', '?sort=id&sort=createdAt'],
      ['limit 0', '?limit=0'],
      ['limit 101 (not clamped)', '?limit=101'],
      ['non-numeric limit', '?limit=abc'],
      ['negative limit', '?limit=-1'],
      ['unknown status', '?status=banned'],
      ['unknown sort', '?sort=email'],
      ['unknown order', '?order=ASC'],
      ['unknown searchBy', '?searchBy=phone&q=abc'],
      ['searchBy without q', '?searchBy=email'],
      ['q without searchBy', '?q=abc'],
      ['too short email q', '?searchBy=email&q=ab'],
      ['email q with a space', '?searchBy=email&q=a%20bc'],
      ['too short displayName q', '?searchBy=displayName&q=ab'],
      ['control char in displayName q', '?searchBy=displayName&q=ab%01c'],
      ['bad id q', '?searchBy=id&q=a%20b'],
      ['id q with $%^', '?searchBy=id&q=%24%25%5E'],
      ['id q over 128 chars', `?searchBy=id&q=${'a'.repeat(129)}`],
      ['empty cursor', '?cursor='],
    ])('%s', async (_label, query) => {
      const res = await list(query, admin);
      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toContain('application/problem+json');
    });

    it('accepts limit 100 and a default of 20', async () => {
      expect((await list('?limit=100', admin)).statusCode).toBe(200);
      const res = await list('', admin);
      expect(res.json().items.length).toBeLessThanOrEqual(20);
    });
  });

  describe('items', () => {
    it('returns exactly the safe fields, never the hash or the photo key', async () => {
      const u = await createUser('shape', { photo: true });
      const res = await list(
        `?searchBy=email&q=${encodeURIComponent(u.email)}`,
        admin,
      );
      expect(res.statusCode).toBe(200);
      const [item] = res.json().items;
      expect(Object.keys(item).sort()).toEqual([
        'createdAt',
        'displayName',
        'email',
        'id',
        'photoUrl',
        'status',
        'updatedAt',
      ]);
      expect(item).toMatchObject({
        id: u.id,
        email: u.email,
        displayName: 'Jane Doe',
        status: 'active',
        photoUrl: `https://api.test/users/${u.id}/photo`,
      });
      expect(res.body).not.toContain(SECRET_HASH);
      expect(res.body).not.toContain(PHOTO_KEY_PREFIX);
      expect(Object.keys(res.json()).sort()).toEqual(['items', 'nextCursor']);
    });

    it('has a null photoUrl without a photo and for deleting/deleted users', async () => {
      const none = await createUser('nophoto', { displayName: null });
      const deleting = await createUser('deleting', {
        status: 'deleting',
        photo: true,
      });
      const deleted = await createUser('deleted', { status: 'deleted' });
      const res = await list(
        `?searchBy=email&q=${PREFIX}-${RUN}-no&limit=10`,
        admin,
      );
      expect(res.json().items.find((i: any) => i.id === none.id)).toMatchObject(
        {
          photoUrl: null,
          displayName: null,
        },
      );
      for (const user of [deleting, deleted]) {
        const r = await list(
          `?searchBy=email&q=${encodeURIComponent(user.email)}`,
          admin,
        );
        expect(r.json().items[0].photoUrl).toBeNull();
      }
    });

    it('returns an empty list and no cursor when nothing matches', async () => {
      const res = await list(
        `?searchBy=email&q=${PREFIX}-${RUN}-does-not-exist`,
        admin,
      );
      expect(res.json()).toEqual({ items: [], nextCursor: null });
    });
  });

  describe('keyset pagination', () => {
    const scope = () => `searchBy=email&q=${PREFIX}-${RUN}-page-`;
    let ids: string[];
    const t0 = '2026-03-01T10:00:00.000000Z';
    const tie = '2026-03-01T10:00:05.123456Z';

    beforeAll(async () => {
      // 7 users: three share one created_at (tie-break on id), four are distinct.
      const made = [
        await createUser('page-a', { createdAt: t0 }),
        await createUser('page-b', { createdAt: '2026-03-01T10:00:01Z' }),
        await createUser('page-c', { createdAt: tie }),
        await createUser('page-d', { createdAt: tie }),
        await createUser('page-e', { createdAt: tie }),
        await createUser('page-f', { createdAt: '2026-03-01T10:00:09Z' }),
        await createUser('page-g', { createdAt: '2026-03-01T10:00:10Z' }),
      ];
      ids = made.map((m) => m.id);
    });

    it('desc by createdAt: every row exactly once, newest first, ties by id desc', async () => {
      const pages = await drain(scope(), 2);
      expect(pages.map((p) => p.length)).toEqual([2, 2, 2, 1]);
      const flat = pages.flat();
      expect(flat.map((i) => i.id).sort()).toEqual([...ids].sort());
      expect(new Set(flat.map((i) => i.id)).size).toBe(7);
      const times = flat.map((i) => i.createdAt);
      expect([...times].sort().reverse()).toEqual(times);
      const tied = flat.filter(
        (i) => i.createdAt === '2026-03-01T10:00:05.123Z',
      );
      expect(tied.map((i) => i.id)).toEqual(
        tied
          .map((i) => i.id)
          .sort()
          .reverse(),
      );
    });

    it('asc by createdAt: reverse order, ties by id asc', async () => {
      const flat = (await drain(`${scope()}&order=asc`, 3)).flat();
      expect(flat).toHaveLength(7);
      const times = flat.map((i) => i.createdAt);
      expect([...times].sort()).toEqual(times);
      const tied = flat.filter(
        (i) => i.createdAt === '2026-03-01T10:00:05.123Z',
      );
      expect(tied.map((i) => i.id)).toEqual(tied.map((i) => i.id).sort());
    });

    it.each(['asc', 'desc'])(
      'sort=id %s covers every row once in id order',
      async (order) => {
        const flat = (
          await drain(`${scope()}&sort=id&order=${order}`, 3)
        ).flat();
        expect(flat).toHaveLength(7);
        const got = flat.map((i) => i.id);
        const sorted = [...got].sort();
        expect(got).toEqual(order === 'asc' ? sorted : sorted.reverse());
      },
    );

    it('returns no cursor on the exact last page and a cursor otherwise', async () => {
      const exact = await list(`?${scope()}&limit=7`, admin);
      expect(exact.json().items).toHaveLength(7);
      expect(exact.json().nextCursor).toBeNull();
      const partial = await list(`?${scope()}&limit=6`, admin);
      expect(partial.json().nextCursor).toEqual(expect.any(String));
    });

    it('limit may change between pages', async () => {
      const first = await list(`?${scope()}&limit=2`, admin);
      const second = await list(
        `?${scope()}&limit=5&cursor=${first.json().nextCursor}`,
        admin,
      );
      expect(second.statusCode).toBe(200);
      expect(second.json().items).toHaveLength(5);
      expect(second.json().nextCursor).toBeNull();
    });

    it('snapshot: a user created after page 1 never appears on later pages', async () => {
      const first = await list(`?${scope()}&limit=3`, admin);
      const late = await createUser('page-late'); // created_at = now() > snapshotAt
      const second = await list(
        `?${scope()}&limit=100&cursor=${first.json().nextCursor}`,
        admin,
      );
      expect(second.statusCode).toBe(200);
      expect(second.json().items.map((i: any) => i.id)).not.toContain(late.id);
      expect(second.json().items).toHaveLength(4);
    });

    it('cursor payload is signed, has the documented fields and no personal data', async () => {
      const res = await list(`?${scope()}&status=active&limit=2`, admin);
      const cursor: string = res.json().nextCursor;
      const [segment, signature] = cursor.split('.');
      expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const payload = JSON.parse(Buffer.from(segment, 'base64url').toString());
      expect(Object.keys(payload).sort()).toEqual(
        [
          'v',
          'kid',
          'sort',
          'order',
          'snapshotAt',
          'lastSortValue',
          'lastTieBreaker',
          'queryTag',
          'issuedAt',
          'expiresAt',
        ].sort(),
      );
      expect(payload).toMatchObject({
        v: 1,
        kid: 'k1',
        sort: 'createdAt',
        order: 'desc',
      });
      expect(payload.expiresAt - payload.issuedAt).toBe(15 * 60 * 1000);
      const raw = JSON.stringify(payload);
      expect(raw).not.toContain(PREFIX);
      expect(raw).not.toContain('active');
    });
  });

  describe('invalid_cursor (400)', () => {
    const base = `searchBy=email&q=${PREFIX}-${RUN}-page-`;
    let cursor: string;

    beforeAll(async () => {
      cursor = (await list(`?${base}&limit=1`, admin)).json().nextCursor;
    });

    const expectInvalid = async (query: string) => {
      const res = await list(query, admin);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('invalid_cursor');
    };

    it('tampered payload', async () => {
      const [segment, sig] = cursor.split('.');
      const payload = JSON.parse(Buffer.from(segment, 'base64url').toString());
      payload.lastSortValue = '2000-01-01T00:00:00.000000Z';
      const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
      await expectInvalid(`?${base}&limit=1&cursor=${forged}`);
    });

    it('tampered signature, garbage and truncated cursors', async () => {
      await expectInvalid(`?${base}&cursor=${cursor.slice(0, -4)}AAAA`);
      await expectInvalid(`?${base}&cursor=garbage`);
      await expectInvalid(`?${base}&cursor=${cursor.split('.')[0]}`);
    });

    it('queryTag mismatch: another filter, search or order', async () => {
      await expectInvalid(`?${base}&status=blocked&cursor=${cursor}`);
      await expectInvalid(
        `?searchBy=email&q=${PREFIX}-${RUN}-other&cursor=${cursor}`,
      );
      await expectInvalid(`?${base}&order=asc&cursor=${cursor}`);
      await expectInvalid(`?${base}&sort=id&cursor=${cursor}`);
      await expectInvalid(`?cursor=${cursor}`); // filter dropped
    });

    it('expired after 15 minutes, still valid just before', async () => {
      const real = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(real + 15 * 60 * 1000 - 5000);
      expect((await list(`?${base}&cursor=${cursor}`, admin)).statusCode).toBe(
        200,
      );
      jest.spyOn(Date, 'now').mockReturnValue(real + 15 * 60 * 1000 + 1000);
      await expectInvalid(`?${base}&cursor=${cursor}`);
    });

    it('a cursor from another key set is rejected', async () => {
      const other = await createApp({
        USER_LIST_CURSOR_HMAC_KEYS: `k1:${'z'.repeat(40)}`,
      });
      try {
        const foreign = (await list(`?${base}&limit=1`, admin, other)).json()
          .nextCursor;
        await expectInvalid(`?${base}&cursor=${foreign}`);
      } finally {
        await other.close();
      }
    });
  });

  describe('search and filters', () => {
    let jane: { id: string; email: string };
    let blocked: { id: string; email: string };

    beforeAll(async () => {
      jane = await createUser('find-jane', { displayName: 'José Ñandú' });
      await createUser('find-under_score', { displayName: 'a_b c' });
      await createUser('find-underXscore', { displayName: 'aXb c' });
      await createUser('find-pct%x', { displayName: '100% real' });
      await createUser('find-pctYx', { displayName: '100Y real' });
      blocked = await createUser('find-blocked', { status: 'blocked' });
      for (const status of ['pending', 'deleting', 'deleted']) {
        await createUser(`find-${status}`, { status });
      }
    });

    const ids = (res: { json: () => any }) =>
      res.json().items.map((i: any) => i.id);

    it('searchBy=id: exact match', async () => {
      const res = await list(`?searchBy=id&q=${jane.id}`, admin);
      expect(ids(res)).toEqual([jane.id]);
    });

    it('searchBy=id: a non-uuid or unknown id gives an empty page, not an error', async () => {
      for (const q of [
        'not-a-uuid',
        'user_123',
        '00000000-0000-4000-8000-000000000000',
      ]) {
        const res = await list(`?searchBy=id&q=${q}`, admin);
        expect(res.json()).toEqual({ items: [], nextCursor: null });
      }
    });

    it('searchBy=email: case-insensitive, trimmed prefix', async () => {
      const q = encodeURIComponent(
        `  ${jane.email.slice(0, 30).toUpperCase()} `,
      );
      const res = await list(`?searchBy=email&q=${q}`, admin);
      expect(ids(res)).toContain(jane.id);
    });

    it('searchBy=email: % and _ are literal', async () => {
      const prefix = `${PREFIX}-${RUN}-find-`;
      const under = await list(
        `?searchBy=email&q=${encodeURIComponent(`${prefix}under_`)}`,
        admin,
      );
      expect(under.json().items).toHaveLength(1);
      expect(under.json().items[0].email).toContain('under_score');
      const pct = await list(
        `?searchBy=email&q=${encodeURIComponent(`${prefix}pct%`)}`,
        admin,
      );
      expect(pct.json().items).toHaveLength(1);
      expect(pct.json().items[0].email).toContain('pct%x');
      // a bare wildcard is not a wildcard
      const wild = await list(
        `?searchBy=email&q=${encodeURIComponent('%%%')}`,
        admin,
      );
      expect(wild.json().items).toEqual([]);
    });

    it('searchBy=displayName: NFC-normalized, case-insensitive prefix (NFD input matches)', async () => {
      const nfd = 'JOSÉ ñ'.normalize('NFD').slice(0, 6); // "JOSÉ" decomposed + start
      const res = await list(
        `?searchBy=displayName&q=${encodeURIComponent(nfd)}`,
        admin,
      );
      expect(ids(res)).toContain(jane.id);
    });

    it('searchBy=displayName: % and _ are literal', async () => {
      const under = await list(
        `?searchBy=displayName&q=${encodeURIComponent('a_b')}`,
        admin,
      );
      expect(under.json().items.map((i: any) => i.displayName)).toEqual([
        'a_b c',
      ]);
      const pct = await list(
        `?searchBy=displayName&q=${encodeURIComponent('100%')}`,
        admin,
      );
      expect(pct.json().items.map((i: any) => i.displayName)).toEqual([
        '100% real',
      ]);
    });

    it.each(['pending', 'active', 'blocked', 'deleting', 'deleted'])(
      'status=%s returns only that status',
      async (status) => {
        const res = await list(
          `?status=${status}&searchBy=email&q=${PREFIX}-${RUN}-find-&limit=100`,
          admin,
        );
        expect(res.statusCode).toBe(200);
        const items = res.json().items;
        expect(items.length).toBeGreaterThan(0);
        expect(items.every((i: any) => i.status === status)).toBe(true);
      },
    );

    it('combines status with search', async () => {
      const res = await list(
        `?status=blocked&searchBy=email&q=${encodeURIComponent(blocked.email)}`,
        admin,
      );
      expect(ids(res)).toEqual([blocked.id]);
      const none = await list(
        `?status=active&searchBy=email&q=${encodeURIComponent(blocked.email)}`,
        admin,
      );
      expect(none.json().items).toEqual([]);
    });
  });

  describe('failures and limits', () => {
    it('503 when the DB statement fails or times out', async () => {
      jest
        .spyOn(app.db, 'transaction')
        .mockRejectedValue(
          Object.assign(new Error('timeout'), { code: '57014' }),
        );
      const res = await list('?limit=1', admin);
      expect(res.statusCode).toBe(503);
      expect(res.headers['content-type']).toContain('application/problem+json');
    });

    it('429 beyond 60 requests per actor, with a Retry-After hint', async () => {
      const limited = await createApp({ ADMIN_USERS_LIST_ACTOR_LIMIT: '3' });
      try {
        for (let i = 0; i < 3; i++) {
          expect((await list('?limit=1', admin, limited)).statusCode).toBe(200);
        }
        const res = await list('?limit=1', admin, limited);
        expect(res.statusCode).toBe(429);
        expect(res.json().code).toBe('rate_limit_exceeded');
        expect(res.json().retryAfterSeconds).toBeGreaterThan(0);
      } finally {
        await limited.close();
      }
    });

    it('429 beyond the per-IP limit across actors', async () => {
      const limited = await createApp({ ADMIN_USERS_LIST_IP_LIMIT: '2' });
      try {
        expect((await list('?limit=1', admin, limited)).statusCode).toBe(200);
        expect((await list('?limit=1', admin, limited)).statusCode).toBe(200);
        expect((await list('?limit=1', admin, limited)).statusCode).toBe(429);
      } finally {
        await limited.close();
      }
    });

    it('permission is checked before the rate limit (no 429 for a forbidden actor)', async () => {
      const limited = await createApp({ ADMIN_USERS_LIST_ACTOR_LIMIT: '1' });
      try {
        for (let i = 0; i < 3; i++) {
          expect((await list('', noPerms, limited)).statusCode).toBe(403);
        }
      } finally {
        await limited.close();
      }
    });

    it('503 and a failing readiness probe when the cursor keys are misconfigured', async () => {
      const broken = await createApp({
        USER_LIST_CURSOR_HMAC_KEYS: 'k1:too-short',
      });
      try {
        const res = await list('?limit=1', admin, broken);
        expect(res.statusCode).toBe(503);
        const ready = await broken.inject({
          method: 'GET',
          url: '/health/ready',
        });
        expect(ready.statusCode).toBe(503);
        expect(JSON.stringify(ready.json())).toContain('user_list_cursor_keys');
        expect(JSON.stringify(ready.json())).not.toContain('too-short');
      } finally {
        await broken.close();
      }
    });
  });

  describe('indexes', () => {
    it('the migration created the five indexes', async () => {
      const rows: { indexname: string; indexdef: string }[] =
        await app.db.query(
          `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'users'`,
        );
      const defs = rows.map((r) => r.indexdef).join('\n');
      expect(defs).toContain('(created_at, id)');
      expect(defs).toContain('(status, created_at, id)');
      expect(defs).toContain('(status, id, created_at)');
      expect(defs).toContain('(email text_pattern_ops)');
      expect(defs).toMatch(
        /lower\(NORMALIZE\(display_name, NFC\)\) text_pattern_ops\) WHERE \(display_name IS NOT NULL\)/,
      );
    });
  });

  describe('OpenAPI', () => {
    it('documents the endpoint, its query parameters and error responses', async () => {
      const doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('test').build(),
      );
      const op = (doc.paths as any)['/admin/users'].get;
      expect(op.parameters.map((p: any) => p.name).sort()).toEqual(
        ['cursor', 'limit', 'order', 'q', 'searchBy', 'sort', 'status'].sort(),
      );
      expect(Object.keys(op.responses).sort()).toEqual(
        ['200', '400', '401', '403', '429', '503'].sort(),
      );
      const limit = op.parameters.find((p: any) => p.name === 'limit');
      expect(limit.schema).toMatchObject({ minimum: 1, maximum: 100 });
      expect(doc.components?.schemas).toHaveProperty('ListUsersResponseDto');
    });
  });
});
