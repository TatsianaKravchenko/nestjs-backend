/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { Logger, ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { AppModule } from '../src/core/app/app.module';
import { ConfigService } from '../src/core/config/config.service';
import { authorizationUnavailable } from '../src/modules/auth/errors/auth.errors';
import { ProblemDetailsExceptionFilter } from '../src/modules/auth/errors/problem-details-exception.filter';
import { MailService } from '../src/modules/auth/services/mail.service';
import { TokenService } from '../src/modules/auth/services/token.service';
import { PolicySnapshotService } from '../src/modules/rbac/policy-snapshot.service';
import { PHOTO_STORAGE } from '../src/modules/users/storage/photo-storage';
import { UsersService } from '../src/modules/users/users.service';

// Must not start with "e2e-" (the registration e2e deletes 'e2e-%' users).
const PREFIX = 'profile-spec';
const DOMAIN = '@example.test';
const SECRET_HASH = 'x-secret-password-hash';
const PHOTO_KEY = 'secret-photo-key.webp';
const PHOTO_BYTES = 'RIFF-fake-webp-bytes';
const MISSING_UUID = '00000000-0000-4000-8000-0000000000aa';
let counter = 0;
const unique = (label: string) =>
  `${PREFIX}-${label}-${Date.now()}-${counter++}`;

type TestApp = NestFastifyApplication & { db: DataSource };
let transactionalReady = false;

async function createApp(storageDir: string): Promise<TestApp> {
  if (!transactionalReady) {
    initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });
    transactionalReady = true;
  }
  const env: Record<string, string> = {
    REGISTRATION_CONFIRMATION_ENABLED: 'false',
    PHOTO_STORAGE_DIR: storageDir,
    API_PUBLIC_URL: 'https://api.test',
    PROFILE_READ_WINDOW_MS: '60000',
    PROFILE_READ_OWN_LIMIT: '120',
    PROFILE_READ_FOREIGN_LIMIT: '60',
  };
  const config = { get: (key: string) => env[key] ?? process.env[key] };
  const mail = {
    sendRegistrationOtp: () => Promise.resolve(),
    sendRegistrationMagicLink: () => Promise.resolve(),
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ConfigService)
    .useValue(config)
    .overrideProvider(MailService)
    .useValue(mail)
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ routerOptions: { maxParamLength: 256 } }), // same as main.ts
  ) as TestApp;
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.useGlobalFilters(new ProblemDetailsExceptionFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  app.db = app.get(DataSource);
  return app;
}

describe('User profile read (e2e)', () => {
  let app: TestApp;
  let storageDir: string;
  let readerRoleId: string;
  let readAnyRoleId: string;

  // actors
  let reader: string; // users@read only
  let admin: string; // users@read + users@read_any
  let readAnyOnly: string; // users@read_any without users@read
  let noPerms: string; // active, no roles
  // targets
  let target: string; // active, with photo
  let targetNoPhoto: string;

  const bump = () =>
    app.db.query(
      'UPDATE rbac_policy_state SET version = version + 1 WHERE id = 1',
    );

  async function createUser(
    label: string,
    options: {
      status?: string;
      displayName?: string | null;
      photoKey?: string | null;
      roles?: string[];
    } = {},
  ): Promise<string> {
    const rows: { id: string }[] = await app.db.query(
      `INSERT INTO users (email, password_hash, status, display_name, photo_key)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        `${unique(label)}${DOMAIN}`,
        SECRET_HASH,
        options.status ?? 'active',
        options.displayName === undefined ? 'Jane Doe' : options.displayName,
        options.photoKey === undefined ? null : options.photoKey,
      ],
    );
    for (const roleId of options.roles ?? []) {
      await app.db.query(
        'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
        [rows[0].id, roleId],
      );
    }
    if (options.roles?.length) await bump();
    return rows[0].id;
  }

  async function call(url: string, as?: string, rawCookie?: string) {
    const headers: Record<string, string> = {};
    if (as) {
      const { access } = await app
        .get(TokenService, { strict: false })
        .issuePair(as);
      headers.cookie = `access_token=${access}`;
    } else if (rawCookie) {
      headers.cookie = rawCookie;
    }
    return app.inject({ method: 'GET', url, headers });
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

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'profile-e2e-'));
    await writeFile(join(storageDir, PHOTO_KEY), PHOTO_BYTES);
    app = await createApp(storageDir);

    // The `users` permission must offer read and read_any (shared, never deleted).
    await app.db.query(
      `INSERT INTO permissions (name, actions)
       VALUES ('users', '{read,read_any,update,delete,list}')
       ON CONFLICT (name) DO UPDATE SET actions = (
         SELECT array_agg(DISTINCT a) FROM unnest(permissions.actions || '{read,read_any}'::varchar[]) a
       )`,
    );
    readerRoleId = await createRole('reader', ['read']);
    readAnyRoleId = await createRole('reader-any', ['read', 'read_any']);
    const onlyAnyRoleId = await createRole('only-any', ['read_any']);

    reader = await createUser('reader', { roles: [readerRoleId] });
    admin = await createUser('admin', { roles: [readAnyRoleId] });
    readAnyOnly = await createUser('any-only', { roles: [onlyAnyRoleId] });
    noPerms = await createUser('noperms');
    target = await createUser('target', {
      displayName: 'Tëst Üser',
      photoKey: PHOTO_KEY,
    });
    targetNoPhoto = await createUser('nophoto', { displayName: null });
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
    await rm(storageDir, { recursive: true, force: true });
  });

  describe('GET /users/:userId', () => {
    it('200: reader sees own profile; body has exactly the documented fields', async () => {
      const res = await call(`/users/${reader}`, reader);

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual([
        'createdAt',
        'displayName',
        'email',
        'id',
        'photoUrl',
        'status',
        'updatedAt',
      ]);
      expect(body).toMatchObject({
        id: reader,
        displayName: 'Jane Doe',
        photoUrl: null,
        status: 'active',
      });
      expect(body.email).toMatch(new RegExp(`^${PREFIX}-reader-.*${DOMAIN}$`));
      expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);
      expect(new Date(body.updatedAt).toISOString()).toBe(body.updatedAt);
    });

    it('200: admin reads a foreign profile in the same shape, with a photo url', async () => {
      const res = await call(`/users/${target}`, admin);

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual([
        'createdAt',
        'displayName',
        'email',
        'id',
        'photoUrl',
        'status',
        'updatedAt',
      ]);
      expect(body).toMatchObject({
        id: target,
        displayName: 'Tëst Üser',
        photoUrl: `https://api.test/users/${target}/photo`,
      });
    });

    it('never leaks internal fields', async () => {
      const res = await call(`/users/${target}`, admin);

      expect(res.body).not.toContain(SECRET_HASH);
      expect(res.body).not.toContain(PHOTO_KEY);
      expect(res.body).not.toMatch(
        /password|photo_?key|hash|token|role|permission|bucket/i,
      );
    });

    it('null display name and photo url for a user without them', async () => {
      const res = await call(`/users/${targetNoPhoto}`, admin);

      expect(res.json()).toMatchObject({ displayName: null, photoUrl: null });
    });

    it.each(['pending', 'active', 'blocked', 'deleting', 'deleted'])(
      'returns a %s target to a caller with read_any',
      async (status) => {
        const id = await createUser(`t-${status}`, {
          status,
          photoKey: PHOTO_KEY,
        });

        const res = await call(`/users/${id}`, admin);

        expect(res.statusCode).toBe(200);
        expect(res.json().status).toBe(status);
        // Photo url is hidden once deletion has been accepted.
        const hidden = status === 'deleting' || status === 'deleted';
        expect(res.json().photoUrl === null).toBe(hidden);
      },
    );

    describe('check order', () => {
      it('400 for a malformed id, before authentication', async () => {
        for (const bad of ['a b', 'x'.repeat(129), 'a.b', 'a%20b', 'юзер']) {
          const res = await call(`/users/${encodeURIComponent(bad)}`);
          expect([bad, res.statusCode]).toEqual([bad, 400]);
        }
        const withToken = await call('/users/a.b', admin);
        expect(withToken.statusCode).toBe(400);
      });

      it('401 without a token, with garbage, or for a tampered token', async () => {
        expect((await call(`/users/${target}`)).statusCode).toBe(401);
        expect(
          (await call(`/users/${target}`, undefined, 'access_token=nope'))
            .statusCode,
        ).toBe(401);
        const { access } = await app
          .get(TokenService, { strict: false })
          .issuePair(admin);
        expect(
          (await call(`/users/${target}`, undefined, `access_token=${access}x`))
            .statusCode,
        ).toBe(401);
      });

      it('401 for a refresh token used as an access token', async () => {
        const { refresh } = await app
          .get(TokenService, { strict: false })
          .issuePair(admin);

        const res = await call(
          `/users/${target}`,
          undefined,
          `access_token=${refresh}`,
        );

        expect(res.statusCode).toBe(401);
        expect(res.json()).toMatchObject({ code: 'invalid_session' });
      });

      it.each(['pending', 'blocked', 'deleting', 'deleted'])(
        '401 for an actor in status %s, even with every permission, before RBAC',
        async (status) => {
          const actor = await createUser(`actor-${status}`, {
            status,
            roles: [readAnyRoleId],
          });
          const authorize = jest.spyOn(
            app.get(PolicySnapshotService),
            'authorize',
          );

          const res = await call(`/users/${target}`, actor);

          expect(res.statusCode).toBe(401);
          expect(res.json()).toMatchObject({ code: 'invalid_session' });
          expect(authorize).not.toHaveBeenCalled();
        },
      );

      it('401 for a valid token of a user that does not exist', async () => {
        const res = await call(`/users/${target}`, MISSING_UUID);

        expect(res.statusCode).toBe(401);
      });

      it('403 without users@read, for own, foreign and unknown ids alike', async () => {
        for (const id of [noPerms, target, MISSING_UUID]) {
          const res = await call(`/users/${id}`, noPerms);
          expect([id, res.statusCode]).toEqual([id, 403]);
          expect(res.json()).toMatchObject({ code: 'permission_denied' });
        }
      });

      it('403 without users@read even when users@read_any is held', async () => {
        const res = await call(`/users/${target}`, readAnyOnly);

        expect(res.statusCode).toBe(403);
      });

      it('403 for a foreign id without read_any, whether or not it exists', async () => {
        const existing = await call(`/users/${target}`, reader);
        const missing = await call(`/users/${MISSING_UUID}`, reader);

        expect(existing.statusCode).toBe(403);
        expect(missing.statusCode).toBe(403);
        expect(existing.json().detail).toBe(missing.json().detail);
      });

      it('queries the target only after every permission passed', async () => {
        const findProfile = jest.spyOn(app.get(UsersService), 'findProfile');

        await call(`/users/${target}`, noPerms); // no users@read
        await call(`/users/${target}`, reader); // no users@read_any
        await call(`/users/a.b`, admin); // malformed
        await call(`/users/${target}`); // no session
        expect(findProfile).not.toHaveBeenCalled();

        await call(`/users/${target}`, admin);
        expect(findProfile).toHaveBeenCalledTimes(1);
      });

      it('404 for a missing target, only for callers allowed to look', async () => {
        const res = await call(`/users/${MISSING_UUID}`, admin);

        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ code: 'not_found' });
      });

      it('404 (not 403) for an unknown id of the legal format to read_any holders', async () => {
        const res = await call('/users/some_unknown-id', admin);

        expect(res.statusCode).toBe(404);
      });

      it('picks up a role change on the next request', async () => {
        const actor = await createUser('late-grant');
        expect((await call(`/users/${actor}`, actor)).statusCode).toBe(403);

        await app.db.query(
          'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
          [actor, readerRoleId],
        );
        await bump();

        expect((await call(`/users/${actor}`, actor)).statusCode).toBe(200);
      });
    });

    describe('failures', () => {
      it('503 when the user database fails after authorization', async () => {
        jest
          .spyOn(app.get(UsersService), 'findProfile')
          .mockRejectedValue(new Error('db down'));

        const res = await call(`/users/${target}`, admin);

        expect(res.statusCode).toBe(503);
        expect(res.body).not.toContain('db down');
      });

      it('503 when the RBAC snapshot is unavailable', async () => {
        jest
          .spyOn(app.get(PolicySnapshotService), 'authorize')
          .mockRejectedValue(authorizationUnavailable());

        const res = await call(`/users/${target}`, admin);

        expect(res.statusCode).toBe(503);
      });

      it('503 when the actor lookup fails during authentication', async () => {
        jest
          .spyOn(app.get(UsersService), 'findAuthState')
          .mockRejectedValue(new Error('db down'));

        const res = await call(`/users/${target}`, admin);

        expect(res.statusCode).toBe(503);
      });
    });

    describe('rate limit', () => {
      it('429 after 120 own reads per minute', async () => {
        const actor = await createUser('own-limit', { roles: [readerRoleId] });

        for (let i = 0; i < 120; i++) {
          const res = await call(`/users/${actor}`, actor);
          if (res.statusCode !== 200) {
            throw new Error(`request ${i} answered ${res.statusCode}`);
          }
        }
        const blocked = await call(`/users/${actor}`, actor);

        expect(blocked.statusCode).toBe(429);
        expect(blocked.json()).toMatchObject({
          code: 'rate_limit_exceeded',
          retryAfterSeconds: expect.any(Number),
        });
        // The own photo shares the own bucket.
        expect((await call(`/users/${actor}/photo`, actor)).statusCode).toBe(
          429,
        );
      });

      it('429 after 60 foreign reads per minute, own reads stay available', async () => {
        const actor = await createUser('foreign-limit', {
          roles: [readAnyRoleId],
        });

        for (let i = 0; i < 60; i++) {
          const res = await call(`/users/${target}`, actor);
          if (res.statusCode !== 200) {
            throw new Error(`request ${i} answered ${res.statusCode}`);
          }
        }

        expect((await call(`/users/${target}`, actor)).statusCode).toBe(429);
        expect((await call(`/users/${actor}`, actor)).statusCode).toBe(200);
      });
    });

    describe('audit log', () => {
      it('logs a foreign read without PII or secrets', async () => {
        const lines: string[] = [];
        for (const level of ['log', 'warn', 'error'] as const) {
          jest
            .spyOn(Logger.prototype, level)
            .mockImplementation((message: unknown) => {
              lines.push(JSON.stringify(message));
            });
        }
        const email: { email: string }[] = await app.db.query(
          'SELECT email FROM users WHERE id = $1',
          [target],
        );

        await call(`/users/${target}`, admin);
        await call(`/users/${target}/photo`, admin);
        await call(`/users/${target}`, reader); // denied
        await call(`/users/${MISSING_UUID}`, admin); // 404

        const logged = lines.join('\n');
        expect(logged).toContain('users.read');
        expect(logged).toContain(`"targetUserId":"${target}"`);
        expect(logged).toContain('users.access_denied');
        expect(logged).toContain('users.not_found');
        for (const secret of [
          email[0].email,
          'Tëst Üser',
          PHOTO_KEY,
          SECRET_HASH,
          'access_token',
          'https://api.test',
        ]) {
          expect(logged).not.toContain(secret);
        }
        // The denial before lookup does not name the target.
        const denial = lines.find((l) => l.includes('users.access_denied'));
        expect(denial).not.toContain(target);
      });
    });
  });

  describe('GET /users/:userId/photo', () => {
    it('200 streams the WebP bytes with hardened headers', async () => {
      const res = await call(`/users/${target}/photo`, admin);

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('private, max-age=300');
      expect(res.body).toBe(PHOTO_BYTES);
      expect(res.headers['content-disposition']).toBeUndefined();
    });

    it('200 for the own photo with users@read only', async () => {
      const owner = await createUser('photo-owner', {
        photoKey: PHOTO_KEY,
        roles: [readerRoleId],
      });

      const res = await call(`/users/${owner}/photo`, owner);

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(PHOTO_BYTES);
    });

    it('repeats the same checks as the profile', async () => {
      expect((await call('/users/a.b/photo')).statusCode).toBe(400);
      expect((await call(`/users/${target}/photo`)).statusCode).toBe(401);
      expect((await call(`/users/${target}/photo`, noPerms)).statusCode).toBe(
        403,
      );
      expect((await call(`/users/${target}/photo`, reader)).statusCode).toBe(
        403,
      );
      expect(
        (await call(`/users/${target}/photo`, readAnyOnly)).statusCode,
      ).toBe(403);
      expect(
        (await call(`/users/${MISSING_UUID}/photo`, reader)).statusCode,
      ).toBe(403);
      expect(
        (await call(`/users/${MISSING_UUID}/photo`, admin)).statusCode,
      ).toBe(404);
    });

    it('401 for an actor that is not active', async () => {
      const actor = await createUser('photo-blocked', {
        status: 'blocked',
        roles: [readAnyRoleId],
      });

      expect((await call(`/users/${target}/photo`, actor)).statusCode).toBe(
        401,
      );
    });

    it('404 for a user without a photo', async () => {
      const res = await call(`/users/${targetNoPhoto}/photo`, admin);

      expect(res.statusCode).toBe(404);
    });

    it.each(['deleting', 'deleted'])(
      '404 for a %s user, without any storage call',
      async (status) => {
        const id = await createUser(`photo-${status}`, {
          status,
          photoKey: PHOTO_KEY,
        });
        const read = jest.spyOn(app.get(PHOTO_STORAGE), 'read');

        const res = await call(`/users/${id}/photo`, admin);

        expect(res.statusCode).toBe(404);
        expect(read).not.toHaveBeenCalled();
      },
    );

    it.each(['pending', 'blocked'])(
      'serves the photo of a %s user to a caller with read_any',
      async (status) => {
        const id = await createUser(`photo-${status}`, {
          status,
          photoKey: PHOTO_KEY,
        });

        expect((await call(`/users/${id}/photo`, admin)).statusCode).toBe(200);
      },
    );

    it('503 when the key points to a missing object', async () => {
      const id = await createUser('photo-missing', {
        photoKey: 'no-such-object.webp',
      });

      const res = await call(`/users/${id}/photo`, admin);

      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain('no-such-object');
    });

    it('503 when storage is unavailable', async () => {
      jest
        .spyOn(app.get(PHOTO_STORAGE), 'read')
        .mockResolvedValue({ status: 'unavailable' });

      const res = await call(`/users/${target}/photo`, admin);

      expect(res.statusCode).toBe(503);
    });

    it('503 when the user database fails', async () => {
      jest
        .spyOn(app.get(UsersService), 'findPhotoRef')
        .mockRejectedValue(new Error('db down'));

      expect((await call(`/users/${target}/photo`, admin)).statusCode).toBe(
        503,
      );
    });
  });
});
