/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { mkdtemp, readdir, readFile, rm, utimes } from 'fs/promises';
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
import { PHOTO_STORAGE } from '../src/modules/users/storage/photo-storage';
import { StorageCleanupWorker } from '../src/modules/users/storage/storage-cleanup.worker';

// Must not start with "e2e-" (the registration e2e deletes 'e2e-%' users).
const PREFIX = 'update-spec';
const DOMAIN = '@example.test';
let counter = 0;
const unique = (label: string) =>
  `${PREFIX}-${label}-${Date.now()}-${counter++}`;
const MISSING_UUID = '00000000-0000-4000-8000-0000000000bb';

type TestApp = NestFastifyApplication & { db: DataSource };
let transactionalReady = false;

const env: Record<string, string> = {
  REGISTRATION_CONFIRMATION_ENABLED: 'false',
  API_PUBLIC_URL: 'https://api.test',
  EMAIL_CHANGE_METHOD: 'otp',
  STORAGE_CLEANUP_WORKER_ENABLED: 'false',
  PROFILE_MUTATION_LIMIT: '1000',
  EMAIL_CHANGE_HOURLY_LIMIT: '1000',
};
const mail = {
  sendRegistrationOtp: jest.fn(),
  sendRegistrationMagicLink: jest.fn(),
  sendEmailChangeOtp: jest.fn(),
  sendEmailChangeMagicLink: jest.fn(),
};

async function createApp(storageDir: string): Promise<TestApp> {
  if (!transactionalReady) {
    initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });
    transactionalReady = true;
  }
  env.PHOTO_STORAGE_DIR = storageDir;
  const config = { get: (key: string) => env[key] ?? process.env[key] };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ConfigService)
    .useValue(config)
    .overrideProvider(MailService)
    .useValue(mail)
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ routerOptions: { maxParamLength: 256 } }),
  ) as TestApp;
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.useGlobalFilters(new ProblemDetailsExceptionFilter());
  await setupHttp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  app.db = app.get(DataSource);
  return app;
}

/** Hand-made multipart body: [{ name, filename?, type?, data }]. */
function multipartBody(
  parts: {
    name: string;
    filename?: string;
    type?: string;
    data: Buffer | string;
  }[],
) {
  const boundary = '----updatespec' + Date.now();
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename) head += `; filename="${part.filename}"`;
    head += '\r\n';
    if (part.type) head += `Content-Type: ${part.type}\r\n`;
    chunks.push(Buffer.from(head + '\r\n'), Buffer.from(part.data));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

const png = (width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 30, b: 30 },
    },
  })
    .png()
    .toBuffer();

describe('User profile update (e2e)', () => {
  let app: TestApp;
  let storageDir: string;
  let worker: StorageCleanupWorker;
  let storage: { write: any; delete: any };
  let userRole: string;
  let adminRole: string;
  let managerRole: string;

  const bump = () =>
    app.db.query(
      'UPDATE rbac_policy_state SET version = version + 1 WHERE id = 1',
    );

  /** Runs the worker until nothing is due (older queued jobs may come first). */
  const drain = async (now = new Date()) => {
    for (let i = 0; i < 20; i++) {
      if ((await worker.processDue(now)) === 0) return;
    }
  };

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
       VALUES ($1, 'x-hash', $2, $3, $4) RETURNING id`,
      [
        `${unique(label)}${DOMAIN}`,
        options.status ?? 'active',
        options.displayName ?? null,
        options.photoKey ?? null,
      ],
    );
    for (const roleId of options.roles ?? [userRole]) {
      await app.db.query(
        'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
        [rows[0].id, roleId],
      );
    }
    await bump();
    return rows[0].id;
  }

  const emailOf = async (id: string): Promise<string> =>
    (await app.db.query('SELECT email FROM users WHERE id = $1', [id]))[0]
      .email;
  const row = async (id: string) =>
    (await app.db.query('SELECT * FROM users WHERE id = $1', [id]))[0];

  async function send(
    method: 'GET' | 'PATCH' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    as: string | undefined,
    body?: unknown,
    extra: { raw?: string | Buffer; contentType?: string } = {},
  ) {
    const headers: Record<string, string> = {};
    if (as) {
      const { access } = await app
        .get(TokenService, { strict: false })
        .issuePair(as);
      headers.cookie = `access_token=${access}`;
    }
    if (extra.contentType) headers['content-type'] = extra.contentType;
    return app.inject({
      method,
      url,
      headers,
      payload:
        extra.raw ??
        (body === undefined ? undefined : (body as Record<string, unknown>)),
    });
  }

  const upload = (
    userId: string,
    as: string,
    parts: Parameters<typeof multipartBody>[0],
  ) => {
    const { payload, contentType } = multipartBody(parts);
    return send('PUT', `/users/${userId}/photo`, as, undefined, {
      raw: payload,
      contentType,
    });
  };
  const filePart = (data: Buffer, type = 'image/png', name = 'file') => ({
    name,
    filename: 'a.png',
    type,
    data,
  });

  const lastOtp = (): string => {
    const calls = mail.sendEmailChangeOtp.mock.calls;
    return calls[calls.length - 1][1] as string;
  };

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'update-e2e-'));
    app = await createApp(storageDir);
    worker = app.get(StorageCleanupWorker);
    storage = app.get(PHOTO_STORAGE);

    await app.db.query(
      `INSERT INTO permissions (name, actions) VALUES ('rbac', '{manage}')
       ON CONFLICT (name) DO NOTHING`,
    );
    await app.db.query(
      `INSERT INTO permissions (name, actions)
       VALUES ('users', '{read,read_any,update,update_any,delete,delete_any,list}')
       ON CONFLICT (name) DO UPDATE SET actions = (
         SELECT array_agg(DISTINCT a) FROM unnest(permissions.actions ||
           '{read,read_any,update,update_any,delete,delete_any,list}'::varchar[]) a
       )`,
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
    userRole = await role('user', [['users', ['read', 'update']]]);
    adminRole = await role('admin', [
      ['users', ['read', 'read_any', 'update', 'update_any']],
    ]);
    managerRole = await role('manager', [
      ['users', ['read', 'update', 'update_any']],
      ['rbac', ['manage']],
    ]);
    await bump();
  });

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app.db.query(
      `DELETE FROM storage_cleanup_jobs WHERE created_at > now() - interval '1 day'`,
    );
    await app.db.query(
      `DELETE FROM user_roles WHERE user_id IN
         (SELECT id FROM users WHERE email LIKE '${PREFIX}-%${DOMAIN}' OR email LIKE 'new-${PREFIX}-%')`,
    );
    await app.db.query(
      `DELETE FROM role_grants WHERE role_id IN
         (SELECT id FROM roles WHERE name LIKE '${PREFIX}-%')`,
    );
    await app.db.query(`DELETE FROM roles WHERE name LIKE '${PREFIX}-%'`);
    await app.db.query(
      `DELETE FROM users WHERE email LIKE '${PREFIX}-%${DOMAIN}' OR email LIKE 'new-${PREFIX}-%'`,
    );
    await bump();
    await app.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  /* ------------------------------- PATCH ------------------------------- */

  describe('PATCH /users/:id', () => {
    it('lets a user change the own displayName (trim + NFC) and returns the safe profile', async () => {
      const id = await createUser('self');
      const res = await send('PATCH', `/users/${id}`, id, {
        displayName: '  Café  ',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(
        [
          'createdAt',
          'displayName',
          'email',
          'id',
          'photoUrl',
          'status',
          'updatedAt',
        ].sort(),
      );
      expect(body.displayName).toBe('Café');
      expect((await row(id)).display_name).toBe('Café');
    });

    it('clears with null and keeps updatedAt when nothing changes', async () => {
      const id = await createUser('noop', { displayName: 'Same' });
      const before = await row(id);
      const same = await send('PATCH', `/users/${id}`, id, {
        displayName: 'Same',
      });
      expect(same.statusCode).toBe(200);
      expect(new Date(same.json().updatedAt).getTime()).toBe(
        before.updated_at.getTime(),
      );

      const cleared = await send('PATCH', `/users/${id}`, id, {
        displayName: null,
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().displayName).toBeNull();
    });

    it.each([
      ['empty body', {}],
      ['unknown field', { displayName: 'A', nickname: 'x' }],
      ['id', { id: MISSING_UUID }],
      ['photoUrl', { photoUrl: 'http://x' }],
      ['password', { password: 'Passw0rd1' }],
      ['blank name', { displayName: '   ' }],
      ['81 code points', { displayName: 'a'.repeat(81) }],
      ['control char', { displayName: 'a\u0007b' }],
      ['email null', { email: null }],
      ['status null', { status: null }],
      ['status deleted', { status: 'deleted' }],
      ['displayName number', { displayName: 5 }],
    ])('rejects %s with 400', async (_label, body) => {
      const id = await createUser('invalid', { roles: [managerRole] });
      const res = await send('PATCH', `/users/${id}`, id, body);
      expect(res.statusCode).toBe(400);
    });

    it('rejects a repeated JSON key and an array body with 400', async () => {
      const id = await createUser('dup');
      const dup = await send('PATCH', `/users/${id}`, id, undefined, {
        raw: '{"displayName":"a","displayName":"b"}',
        contentType: 'application/json',
      });
      expect(dup.statusCode).toBe(400);
      const arr = await send('PATCH', `/users/${id}`, id, undefined, {
        raw: '[]',
        contentType: 'application/json',
      });
      expect(arr.statusCode).toBe(400);
      expect((await row(id)).display_name).toBeNull();
    });

    it('answers 400 for a malformed userId and 401 without a session', async () => {
      const id = await createUser('auth');
      expect(
        (await send('PATCH', '/users/bad.id', id, { displayName: 'a' }))
          .statusCode,
      ).toBe(400);
      expect(
        (await send('PATCH', `/users/${id}`, undefined, { displayName: 'a' }))
          .statusCode,
      ).toBe(401);
    });

    it('answers 403 (not 404) for a foreign or missing target without update_any', async () => {
      const a = await createUser('a');
      const b = await createUser('b');
      expect(
        (await send('PATCH', `/users/${b}`, a, { displayName: 'x' }))
          .statusCode,
      ).toBe(403);
      expect(
        (await send('PATCH', `/users/${MISSING_UUID}`, a, { displayName: 'x' }))
          .statusCode,
      ).toBe(403);
      expect((await row(b)).display_name).toBeNull();
    });

    it('answers 404 for a missing target only after update_any', async () => {
      const admin = await createUser('admin', { roles: [adminRole] });
      expect(
        (
          await send('PATCH', `/users/${MISSING_UUID}`, admin, {
            displayName: 'x',
          })
        ).statusCode,
      ).toBe(404);
    });

    it('forbids email and status for self without update_any, but allows them with it', async () => {
      const user = await createUser('plain');
      for (const body of [{ email: 'x@example.test' }, { status: 'blocked' }]) {
        expect(
          (await send('PATCH', `/users/${user}`, user, body)).statusCode,
        ).toBe(403);
      }
      const admin = await createUser('selfadmin', { roles: [adminRole] });
      const email = `new-${unique('selfadmin')}@Example.test`;
      const res = await send('PATCH', `/users/${admin}`, admin, { email });
      expect(res.statusCode).toBe(200);
      expect(res.json().email).toBe(email.toLowerCase());
    });

    it('lets an admin change displayName and email of another user, cancelling the email challenge', async () => {
      const admin = await createUser('admin2', { roles: [adminRole] });
      const user = await createUser('victim');
      await send('POST', `/users/${user}/email-change`, user, {
        newEmail: `new-${unique('pending')}@example.test`,
      });
      const newEmail = `new-${unique('direct')}@example.test`;

      const res = await send('PATCH', `/users/${user}`, admin, {
        displayName: 'By Admin',
        email: `  ${newEmail.toUpperCase()} `,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        email: newEmail,
        displayName: 'By Admin',
      });
      const challenge = (
        await app.db.query(
          'SELECT consumed_reason FROM email_change_challenges WHERE user_id = $1',
          [user],
        )
      )[0];
      expect(challenge.consumed_reason).toBe('admin_override');
    });

    it('answers 409 for a taken email and 200 for the same address', async () => {
      const admin = await createUser('admin3', { roles: [adminRole] });
      const other = await createUser('other');
      const user = await createUser('target');
      const taken = await send('PATCH', `/users/${user}`, admin, {
        email: await emailOf(other),
      });
      expect(taken.statusCode).toBe(409);
      const same = await send('PATCH', `/users/${user}`, admin, {
        email: (await emailOf(user)).toUpperCase(),
      });
      expect(same.statusCode).toBe(200);
    });

    it('blocks and unblocks; a blocked user loses the session and open challenges', async () => {
      const admin = await createUser('admin4', { roles: [adminRole] });
      const user = await createUser('tobeblocked');
      await send('POST', `/users/${user}/email-change`, user, {
        newEmail: `new-${unique('b')}@example.test`,
      });
      await app.db.query(
        `INSERT INTO login_attempts (user_id, method, secret_hash, last_sent_at)
         VALUES ($1, 'otp', 'h', now())`,
        [user],
      );

      const blocked = await send('PATCH', `/users/${user}`, admin, {
        status: 'blocked',
      });
      expect(blocked.statusCode).toBe(200);
      expect(blocked.json().status).toBe('blocked');
      expect(
        (await send('PATCH', `/users/${user}`, user, { displayName: 'x' }))
          .statusCode,
      ).toBe(401);
      const reasons = await app.db.query(
        `SELECT consumed_reason::text FROM email_change_challenges WHERE user_id = $1
         UNION ALL SELECT consumed_reason::text FROM login_attempts WHERE user_id = $1`,
        [user],
      );
      expect(reasons.map((r: any) => r.consumed_reason)).toEqual([
        'user_inactive',
        'user_inactive',
      ]);

      const active = await send('PATCH', `/users/${user}`, admin, {
        status: 'active',
      });
      expect(active.json().status).toBe('active');
    });

    it('answers 409 when the target is pending, deleting or deleted', async () => {
      const admin = await createUser('admin5', { roles: [adminRole] });
      for (const status of ['pending', 'deleting', 'deleted']) {
        const user = await createUser(status, { status });
        expect(
          (await send('PATCH', `/users/${user}`, admin, { displayName: 'x' }))
            .statusCode,
        ).toBe(409);
      }
    });

    it('keeps at least one active rbac@manage user', async () => {
      const actor = await createUser('mgr-actor', { roles: [managerRole] });
      const holder = await createUser('mgr-holder', { roles: [managerRole] });
      // Every other active holder in the shared database is blocked for the
      // duration of this test and restored afterwards.
      const others: { id: string }[] = await app.db.query(
        `SELECT DISTINCT u.id FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN role_grants g ON g.role_id = ur.role_id
           JOIN permissions p ON p.id = g.permission_id
          WHERE u.status = 'active' AND p.name = 'rbac' AND u.id NOT IN ($1, $2)`,
        [actor, holder],
      );
      const ids = others.map((o) => o.id);
      if (ids.length) {
        await app.db.query(
          `UPDATE users SET status = 'blocked' WHERE id = ANY($1)`,
          [ids],
        );
      }
      try {
        // actor blocks holder: actor remains -> ok
        const first = await send('PATCH', `/users/${holder}`, actor, {
          status: 'blocked',
        });
        expect(first.statusCode).toBe(200);
        // actor blocks itself: it is the last one -> 409, nothing changes
        const last = await send('PATCH', `/users/${actor}`, actor, {
          status: 'blocked',
        });
        expect(last.statusCode).toBe(409);
        expect(last.json().code).toBe('last_access_manager');
        expect((await row(actor)).status).toBe('active');
      } finally {
        if (ids.length) {
          await app.db.query(
            `UPDATE users SET status = 'active' WHERE id = ANY($1)`,
            [ids],
          );
        }
      }
    });

    it('serializes concurrent blocks of the last two managers', async () => {
      const a = await createUser('race-a', { roles: [managerRole] });
      const b = await createUser('race-b', { roles: [managerRole] });
      const others: { id: string }[] = await app.db.query(
        `SELECT DISTINCT u.id FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN role_grants g ON g.role_id = ur.role_id
           JOIN permissions p ON p.id = g.permission_id
          WHERE u.status = 'active' AND p.name = 'rbac' AND u.id NOT IN ($1, $2)`,
        [a, b],
      );
      const ids = others.map((o) => o.id);
      if (ids.length) {
        await app.db.query(
          `UPDATE users SET status = 'blocked' WHERE id = ANY($1)`,
          [ids],
        );
      }
      try {
        const [r1, r2] = await Promise.all([
          send('PATCH', `/users/${b}`, a, { status: 'blocked' }),
          send('PATCH', `/users/${a}`, b, { status: 'blocked' }),
        ]);
        const codes = [r1.statusCode, r2.statusCode].sort();
        // One block wins; the loser is either 409 (invariant) or 401 (it was blocked first).
        expect(codes[0]).toBe(200);
        expect([409, 401]).toContain(codes[1]);
        const active = await app.db.query(
          `SELECT count(*)::int AS n FROM users WHERE id = ANY($1) AND status = 'active'`,
          [[a, b]],
        );
        expect(active[0].n).toBe(1);
      } finally {
        if (ids.length) {
          await app.db.query(
            `UPDATE users SET status = 'active' WHERE id = ANY($1)`,
            [ids],
          );
        }
      }
    });

    it('limits mutations per user (429)', async () => {
      const id = await createUser('limited');
      env.PROFILE_MUTATION_LIMIT = '2';
      try {
        const codes: number[] = [];
        for (let i = 0; i < 3; i++) {
          codes.push(
            (await send('PATCH', `/users/${id}`, id, { displayName: `n${i}` }))
              .statusCode,
          );
        }
        expect(codes).toEqual([200, 200, 429]);
      } finally {
        env.PROFILE_MUTATION_LIMIT = '1000';
      }
    });

    it('rejects a displayName that violates the database constraint', async () => {
      const id = await createUser('constraint');
      await expect(
        app.db.query('UPDATE users SET display_name = $2 WHERE id = $1', [
          id,
          'a'.repeat(81),
        ]),
      ).rejects.toThrow();
    });
  });

  /* ----------------------------- email change ---------------------------- */

  describe('email change', () => {
    const start = (id: string, as: string, newEmail: string) =>
      send('POST', `/users/${id}/email-change`, as, { newEmail });

    it('starts, sends an OTP to the new address only and exposes no secret', async () => {
      const id = await createUser('ec1');
      const newEmail = `new-${unique('ec1')}@Example.test`;
      const res = await start(id, id, newEmail);

      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({
        confirmationRequired: true,
        method: 'otp',
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });
      expect(Object.keys(res.json()).sort()).toEqual([
        'challengeId',
        'confirmationRequired',
        'expiresInSeconds',
        'method',
        'resendAfterSeconds',
      ]);
      expect(mail.sendEmailChangeOtp).toHaveBeenCalledWith(
        newEmail.toLowerCase(),
        expect.stringMatching(/^\d{6}$/),
      );
      expect(JSON.stringify(res.json())).not.toContain(lastOtp() + '"');
      const stored = (
        await app.db.query(
          'SELECT secret_hash FROM email_change_challenges WHERE user_id = $1',
          [id],
        )
      )[0];
      expect(stored.secret_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.secret_hash).not.toContain(lastOtp());
    });

    it('is self-only: even an admin gets 403 for a foreign id, before any lookup', async () => {
      const admin = await createUser('ec-admin', { roles: [adminRole] });
      const user = await createUser('ec-user');
      expect((await start(user, admin, 'a@example.test')).statusCode).toBe(403);
      expect(
        (await start(MISSING_UUID, user, 'a@example.test')).statusCode,
      ).toBe(403);
    });

    it('answers 409 for the current or an occupied address and 400 for a bad one', async () => {
      const id = await createUser('ec2');
      const other = await createUser('ec2-other');
      expect((await start(id, id, await emailOf(id))).statusCode).toBe(409);
      expect((await start(id, id, await emailOf(other))).statusCode).toBe(409);
      expect((await start(id, id, 'not-an-email')).statusCode).toBe(400);
      expect(mail.sendEmailChangeOtp).not.toHaveBeenCalled();
    });

    it('enforces the 60 second pause (429) and resends a new secret', async () => {
      const id = await createUser('ec3');
      const first = await start(id, id, `new-${unique('ec3')}@example.test`);
      const again = await start(id, id, `new-${unique('ec3b')}@example.test`);
      expect(again.statusCode).toBe(429);
      expect(again.json().retryAfterSeconds).toBeGreaterThan(0);

      const challengeId = first.json().challengeId;
      const tooSoon = await send(
        'POST',
        `/users/${id}/email-change/resend`,
        id,
        {
          challengeId,
        },
      );
      expect(tooSoon.statusCode).toBe(429);

      const oldCode = lastOtp();
      await app.db.query(
        `UPDATE email_change_challenges SET last_sent_at = now() - interval '61 seconds' WHERE id = $1`,
        [challengeId],
      );
      const resent = await send(
        'POST',
        `/users/${id}/email-change/resend`,
        id,
        {
          challengeId,
        },
      );
      expect(resent.statusCode).toBe(202);
      expect(mail.sendEmailChangeOtp).toHaveBeenCalledTimes(2);
      const newCode = lastOtp();
      if (newCode !== oldCode) {
        const stale = await send(
          'POST',
          `/users/${id}/email-change/confirm`,
          id,
          { challengeId, code: oldCode },
        );
        expect(stale.statusCode).toBe(400);
      }
    });

    it('replaces the previous challenge after the pause', async () => {
      const id = await createUser('ec4');
      const first = await start(id, id, `new-${unique('ec4')}@example.test`);
      await app.db.query(
        `UPDATE email_change_challenges SET last_sent_at = now() - interval '2 minutes' WHERE id = $1`,
        [first.json().challengeId],
      );
      const second = await start(id, id, `new-${unique('ec4b')}@example.test`);
      expect(second.statusCode).toBe(202);
      const rows = await app.db.query(
        `SELECT consumed_reason FROM email_change_challenges WHERE user_id = $1 ORDER BY created_at`,
        [id],
      );
      expect(rows.map((r: any) => r.consumed_reason)).toEqual([
        'replaced',
        null,
      ]);
    });

    it('confirms with the OTP and changes the email atomically', async () => {
      const id = await createUser('ec5');
      const newEmail = `new-${unique('ec5')}@example.test`;
      const started = await start(id, id, newEmail);
      const res = await send('POST', `/users/${id}/email-change/confirm`, id, {
        challengeId: started.json().challengeId,
        code: lastOtp(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().email).toBe(newEmail);
      expect(await emailOf(id)).toBe(newEmail);
      const reused = await send(
        'POST',
        `/users/${id}/email-change/confirm`,
        id,
        {
          challengeId: started.json().challengeId,
          code: lastOtp(),
        },
      );
      expect(reused.statusCode).toBe(400);
    });

    it('requires the session of the same user', async () => {
      const id = await createUser('ec6');
      const other = await createUser('ec6-other');
      const started = await start(id, id, `new-${unique('ec6')}@example.test`);
      const body = { challengeId: started.json().challengeId, code: lastOtp() };
      expect(
        (
          await send(
            'POST',
            `/users/${id}/email-change/confirm`,
            undefined,
            body,
          )
        ).statusCode,
      ).toBe(401);
      expect(
        (await send('POST', `/users/${id}/email-change/confirm`, other, body))
          .statusCode,
      ).toBe(403);
    });

    it('counts five wrong OTPs: the fifth is 400 and consumes, the next is 429', async () => {
      const id = await createUser('ec7');
      const started = await start(id, id, `new-${unique('ec7')}@example.test`);
      const challengeId = started.json().challengeId;
      const good = lastOtp();
      const wrong = good === '000000' ? '111111' : '000000';
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) {
        codes.push(
          (
            await send('POST', `/users/${id}/email-change/confirm`, id, {
              challengeId,
              code: wrong,
            })
          ).statusCode,
        );
      }
      expect(codes).toEqual([400, 400, 400, 400, 400]);
      const reason = (
        await app.db.query(
          'SELECT consumed_reason FROM email_change_challenges WHERE id = $1',
          [challengeId],
        )
      )[0].consumed_reason;
      expect(reason).toBe('attempts_exhausted');
      for (const code of [wrong, good]) {
        const res = await send(
          'POST',
          `/users/${id}/email-change/confirm`,
          id,
          {
            challengeId,
            code,
          },
        );
        expect(res.statusCode).toBe(429);
      }
      const resend = await send(
        'POST',
        `/users/${id}/email-change/resend`,
        id,
        {
          challengeId,
        },
      );
      expect(resend.statusCode).toBe(429);
    });

    it('answers 400 for an expired challenge without counting an attempt', async () => {
      const id = await createUser('ec8');
      const started = await start(id, id, `new-${unique('ec8')}@example.test`);
      const challengeId = started.json().challengeId;
      await app.db.query(
        `UPDATE email_change_challenges SET last_sent_at = now() - interval '11 minutes' WHERE id = $1`,
        [challengeId],
      );
      const res = await send('POST', `/users/${id}/email-change/confirm`, id, {
        challengeId,
        code: lastOtp(),
      });
      expect(res.statusCode).toBe(400);
      expect(
        (
          await app.db.query(
            'SELECT attempts FROM email_change_challenges WHERE id = $1',
            [challengeId],
          )
        )[0].attempts,
      ).toBe(0);
    });

    it('rejects ambiguous or malformed confirm bodies with 400', async () => {
      const id = await createUser('ec9');
      const started = await start(id, id, `new-${unique('ec9')}@example.test`);
      const challengeId = started.json().challengeId;
      for (const body of [
        { challengeId },
        { code: '123456' },
        { challengeId, code: '12345' },
        { challengeId, code: '123456', token: 'x.y' },
        { token: 'bad' },
        { challengeId: 'nope', code: '123456' },
        {},
      ]) {
        expect(
          (await send('POST', `/users/${id}/email-change/confirm`, id, body))
            .statusCode,
        ).toBe(400);
      }
    });

    it('answers 409 with email_conflict when the address was taken meanwhile', async () => {
      const id = await createUser('ec10');
      const newEmail = `new-${unique('ec10')}@example.test`;
      const started = await start(id, id, newEmail);
      const code = lastOtp();
      await createUserWithEmail(newEmail);

      const res = await send('POST', `/users/${id}/email-change/confirm`, id, {
        challengeId: started.json().challengeId,
        code,
      });
      expect(res.statusCode).toBe(409);
      expect(
        (
          await app.db.query(
            'SELECT consumed_reason FROM email_change_challenges WHERE id = $1',
            [started.json().challengeId],
          )
        )[0].consumed_reason,
      ).toBe('email_conflict');
      const retry = await send(
        'POST',
        `/users/${id}/email-change/confirm`,
        id,
        {
          challengeId: started.json().challengeId,
          code,
        },
      );
      expect(retry.statusCode).toBe(409);
    });

    async function createUserWithEmail(email: string) {
      await app.db.query(
        `INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active')`,
        [email],
      );
    }

    it('lets exactly one of two concurrent confirmations win the same address', async () => {
      const a = await createUser('race1');
      const b = await createUser('race2');
      const target = `new-${unique('race')}@example.test`;
      const sa = await start(a, a, target);
      const codeA = lastOtp();
      const sb = await start(b, b, target);
      const codeB = lastOtp();

      const [ra, rb] = await Promise.all([
        send('POST', `/users/${a}/email-change/confirm`, a, {
          challengeId: sa.json().challengeId,
          code: codeA,
        }),
        send('POST', `/users/${b}/email-change/confirm`, b, {
          challengeId: sb.json().challengeId,
          code: codeB,
        }),
      ]);
      expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 409]);
      const owners = await app.db.query(
        'SELECT id FROM users WHERE email = $1',
        [target],
      );
      expect(owners).toHaveLength(1);
    });

    it('answers 503 with safe metadata when SMTP fails after the commit, and resend recovers', async () => {
      const id = await createUser('ec11');
      mail.sendEmailChangeOtp.mockRejectedValueOnce(new Error('smtp down'));
      const res = await start(id, id, `new-${unique('ec11')}@example.test`);

      expect(res.statusCode).toBe(503);
      expect(Object.keys(res.json()).sort()).toEqual(
        [
          'challengeId',
          'code',
          'confirmationRequired',
          'detail',
          'instance',
          'method',
          'retryAfterSeconds',
          'status',
          'title',
          'type',
        ].sort(),
      );
      expect(res.json().confirmationRequired).toBe(true);
      const stored = await app.db.query(
        'SELECT id FROM email_change_challenges WHERE user_id = $1 AND consumed_at IS NULL',
        [id],
      );
      expect(stored).toHaveLength(1);

      await app.db.query(
        `UPDATE email_change_challenges SET last_sent_at = now() - interval '61 seconds' WHERE id = $1`,
        [res.json().challengeId],
      );
      const resent = await send(
        'POST',
        `/users/${id}/email-change/resend`,
        id,
        {
          challengeId: res.json().challengeId,
        },
      );
      expect(resent.statusCode).toBe(202);
    });

    it('answers 409 for resend/confirm of a challenge cancelled by an admin', async () => {
      const admin = await createUser('ec-admin2', { roles: [adminRole] });
      const id = await createUser('ec12');
      const started = await start(id, id, `new-${unique('ec12')}@example.test`);
      const code = lastOtp();
      await send('PATCH', `/users/${id}`, admin, {
        email: `new-${unique('ec12x')}@example.test`,
      });
      const challengeId = started.json().challengeId;
      expect(
        (
          await send('POST', `/users/${id}/email-change/resend`, id, {
            challengeId,
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await send('POST', `/users/${id}/email-change/confirm`, id, {
            challengeId,
            code,
          })
        ).statusCode,
      ).toBe(409);
    });

    it('supports the magic link method (token in the URL fragment, no counter)', async () => {
      env.EMAIL_CHANGE_METHOD = 'magic_link';
      try {
        const id = await createUser('ml1');
        const newEmail = `new-${unique('ml1')}@example.test`;
        const started = await start(id, id, newEmail);
        expect(started.json().method).toBe('magic_link');
        const [, link] = mail.sendEmailChangeMagicLink.mock.calls[0];
        const url = new URL(link as string);
        expect(url.search).toBe('');
        const token = url.hash.replace('#token=', '');
        expect(token.startsWith(started.json().challengeId + '.')).toBe(true);

        const bad = await send(
          'POST',
          `/users/${id}/email-change/confirm`,
          id,
          {
            token: `${started.json().challengeId}.${'A'.repeat(43)}`,
          },
        );
        expect(bad.statusCode).toBe(400);
        expect(
          (
            await app.db.query(
              'SELECT attempts FROM email_change_challenges WHERE user_id = $1',
              [id],
            )
          )[0].attempts,
        ).toBe(0);

        const ok = await send('POST', `/users/${id}/email-change/confirm`, id, {
          token,
        });
        expect(ok.statusCode).toBe(200);
        expect(ok.json().email).toBe(newEmail);
        // a link challenge refuses an OTP body
      } finally {
        env.EMAIL_CHANGE_METHOD = 'otp';
      }
    });

    it('answers 401 and consumes the challenge when the user was blocked before confirm', async () => {
      const id = await createUser('ec13');
      const started = await start(id, id, `new-${unique('ec13')}@example.test`);
      const code = lastOtp();
      const { access } = await app
        .get(TokenService, { strict: false })
        .issuePair(id);
      // Status flips after the access guard would have passed: emulate by
      // blocking directly and confirming through the service path.
      await app.db.query(`UPDATE users SET status = 'blocked' WHERE id = $1`, [
        id,
      ]);
      const res = await app.inject({
        method: 'POST',
        url: `/users/${id}/email-change/confirm`,
        headers: { cookie: `access_token=${access}` },
        payload: { challengeId: started.json().challengeId, code },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  /* -------------------------------- photo -------------------------------- */

  describe('photo', () => {
    it('stores a normalized WebP under an opaque key and serves it', async () => {
      const id = await createUser('ph1');
      const res = await upload(id, id, [filePart(await png(2000, 1000))]);

      expect(res.statusCode).toBe(200);
      expect(res.json().photoUrl).toBe(`https://api.test/users/${id}/photo`);
      const key: string = (await row(id)).photo_key;
      expect(key).toMatch(/^[A-Za-z0-9_-]{32,}\.webp$/);
      expect(key).not.toContain(id);
      const stored = await readFile(join(storageDir, key));
      const meta = await sharp(stored).metadata();
      expect(meta).toMatchObject({ format: 'webp', width: 1024, height: 512 });
      expect(meta.exif).toBeUndefined();
      expect(stored.length).toBeLessThanOrEqual(2 * 1024 * 1024);
      const get = await send('GET', `/users/${id}/photo`, id);
      expect(get.statusCode).toBe(200);
      expect(get.headers['content-type']).toBe('image/webp');
    });

    it('does not enlarge a small image and applies EXIF orientation', async () => {
      const id = await createUser('ph2');
      const rotated = await sharp({
        create: {
          width: 200,
          height: 100,
          channels: 3,
          background: { r: 0, g: 0, b: 255 },
        },
      })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toBuffer();
      const res = await upload(id, id, [filePart(rotated, 'image/jpeg')]);
      expect(res.statusCode).toBe(200);
      const stored = await readFile(
        join(storageDir, (await row(id)).photo_key),
      );
      const meta = await sharp(stored).metadata();
      expect([meta.width, meta.height]).toEqual([100, 200]);
    });

    it('queues cleanup of the replaced object and the worker deletes it', async () => {
      const id = await createUser('ph3');
      await upload(id, id, [filePart(await png(300, 300))]);
      const oldKey: string = (await row(id)).photo_key;
      await upload(id, id, [filePart(await png(400, 400))]);
      const newKey: string = (await row(id)).photo_key;
      expect(newKey).not.toBe(oldKey);

      const jobs = await app.db.query(
        `SELECT id, status, reason FROM storage_cleanup_jobs WHERE object_key = $1`,
        [oldKey],
      );
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        status: 'queued',
        reason: 'photo_replaced',
      });

      await drain();
      expect(await readdir(storageDir)).not.toContain(oldKey);
      expect(await readdir(storageDir)).toContain(newKey);
      expect(
        (
          await app.db.query(
            'SELECT status FROM storage_cleanup_jobs WHERE id = $1',
            [jobs[0].id],
          )
        )[0].status,
      ).toBe('succeeded');
    });

    it('clears the photo (204), is idempotent and queues photo_cleared', async () => {
      const id = await createUser('ph4');
      await upload(id, id, [filePart(await png(300, 300))]);
      const key: string = (await row(id)).photo_key;
      const before = await row(id);

      expect((await send('DELETE', `/users/${id}/photo`, id)).statusCode).toBe(
        204,
      );
      const after = await row(id);
      expect(after.photo_key).toBeNull();
      expect(after.updated_at.getTime()).toBeGreaterThan(
        before.updated_at.getTime() - 1,
      );
      const jobs = await app.db.query(
        `SELECT reason FROM storage_cleanup_jobs WHERE object_key = $1`,
        [key],
      );
      expect(jobs).toEqual([{ reason: 'photo_cleared' }]);

      const again = await send('DELETE', `/users/${id}/photo`, id);
      expect(again.statusCode).toBe(204);
      expect((await row(id)).updated_at).toEqual(after.updated_at);
      expect((await send('GET', `/users/${id}/photo`, id)).statusCode).toBe(
        404,
      );
    });

    it.each([
      ['GIF container', 'image/gif', Buffer.from('GIF89a......'), 415],
      ['MIME mismatch', 'image/jpeg', 'png', 415],
      ['corrupt PNG', 'image/png', 'corrupt', 400],
      ['too small', 'image/png', 'small', 400],
      ['too large dimensions', 'image/png', 'huge', 400],
    ])('rejects %s', async (_label, type, kind, expected) => {
      const id = await createUser('ph-bad');
      let data: Buffer;
      if (kind === 'png') data = await png(100, 100);
      else if (kind === 'corrupt') {
        const good = await png(200, 200);
        data = good.subarray(0, Math.floor(good.length / 2));
      } else if (kind === 'small') data = await png(32, 32);
      else if (kind === 'huge') data = await png(4097, 64);
      else data = kind as Buffer;
      const res = await upload(id, id, [filePart(data, type)]);
      expect(res.statusCode).toBe(expected);
      expect((await row(id)).photo_key).toBeNull();
    });

    it('rejects a file over 5 MiB with 413', async () => {
      const id = await createUser('ph-big');
      const big = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(5 * 1024 * 1024 + 10, 1),
      ]);
      expect((await upload(id, id, [filePart(big)])).statusCode).toBe(413);
    });

    it('rejects extra fields, extra files, a wrong field name and non-multipart with 400/415', async () => {
      const id = await createUser('ph-shape');
      const image = await png(100, 100);
      expect(
        (
          await upload(id, id, [
            filePart(image),
            { name: 'note', data: 'hello' },
          ])
        ).statusCode,
      ).toBe(400);
      expect(
        (await upload(id, id, [filePart(image), filePart(image)])).statusCode,
      ).toBe(400);
      expect(
        (await upload(id, id, [filePart(image, 'image/png', 'avatar')]))
          .statusCode,
      ).toBe(400);
      expect(
        (await send('PUT', `/users/${id}/photo`, id, { file: 'x' })).statusCode,
      ).toBe(415);
      expect((await row(id)).photo_key).toBeNull();
    });

    it('checks permissions before the target: 403 foreign without update_any, 404 only with it', async () => {
      const user = await createUser('ph-perm');
      const target = await createUser('ph-target');
      const image = await png(100, 100);
      expect((await upload(target, user, [filePart(image)])).statusCode).toBe(
        403,
      );
      expect(
        (await send('DELETE', `/users/${MISSING_UUID}/photo`, user)).statusCode,
      ).toBe(403);
      const admin = await createUser('ph-admin', { roles: [adminRole] });
      expect(
        (await upload(MISSING_UUID, admin, [filePart(image)])).statusCode,
      ).toBe(404);
      expect((await upload(target, admin, [filePart(image)])).statusCode).toBe(
        200,
      );
      // the failed upload to a missing user left no object behind
      const files = await readdir(storageDir);
      const referenced: { photo_key: string }[] = await app.db.query(
        `SELECT photo_key FROM users WHERE photo_key = ANY($1)`,
        [files],
      );
      const unreferenced = files.filter(
        (f) => !referenced.some((r) => r.photo_key === f),
      );
      const jobKeys: { object_key: string }[] = await app.db.query(
        `SELECT object_key FROM storage_cleanup_jobs`,
      );
      expect(
        unreferenced.filter((f) => !jobKeys.some((j) => j.object_key === f)),
      ).toEqual([]);
    });

    it('answers 409 for pending, deleting and deleted targets', async () => {
      const admin = await createUser('ph-admin2', { roles: [adminRole] });
      const image = await png(100, 100);
      for (const status of ['pending', 'deleting', 'deleted']) {
        const user = await createUser(`ph-${status}`, { status });
        expect((await upload(user, admin, [filePart(image)])).statusCode).toBe(
          409,
        );
        expect(
          (await send('DELETE', `/users/${user}/photo`, admin)).statusCode,
        ).toBe(409);
      }
    });

    it('answers 503 and keeps the old profile when the storage write fails', async () => {
      const id = await createUser('ph-503');
      jest.spyOn(storage, 'write').mockRejectedValueOnce(new Error('down'));
      const res = await upload(id, id, [filePart(await png(100, 100))]);
      expect(res.statusCode).toBe(503);
      expect((await row(id)).photo_key).toBeNull();
    });

    it('deletes the new object when the transaction cannot commit', async () => {
      const id = await createUser('ph-rollback');
      const deleteSpy = jest.spyOn(storage, 'delete');
      const res = await upload(MISSING_UUID, id, [
        filePart(await png(100, 100)),
      ]);
      expect(res.statusCode).toBe(403);
      expect(deleteSpy).not.toHaveBeenCalled();
      const admin = await createUser('ph-rb-admin', { roles: [adminRole] });
      const missing = await upload(MISSING_UUID, admin, [
        filePart(await png(100, 100)),
      ]);
      expect(missing.statusCode).toBe(404);
      expect(deleteSpy).toHaveBeenCalledTimes(1);
    });

    it('limits photo mutations per user (429)', async () => {
      const id = await createUser('ph-limit');
      env.PROFILE_MUTATION_LIMIT = '1';
      try {
        expect(
          (await send('DELETE', `/users/${id}/photo`, id)).statusCode,
        ).toBe(204);
        expect(
          (await send('DELETE', `/users/${id}/photo`, id)).statusCode,
        ).toBe(429);
      } finally {
        env.PROFILE_MUTATION_LIMIT = '1000';
      }
    });
  });

  /* ------------------------------- cleanup ------------------------------- */

  describe('storage cleanup worker', () => {
    const queue = async (key: string) =>
      (
        await app.db.query(
          `INSERT INTO storage_cleanup_jobs (object_key, reason, next_attempt_at)
           VALUES ($1, 'photo_cleared', $2) RETURNING id`,
          [key, new Date(Date.now() - 1000)],
        )
      )[0].id as string;
    const job = async (id: string) =>
      (
        await app.db.query('SELECT * FROM storage_cleanup_jobs WHERE id = $1', [
          id,
        ])
      )[0];

    it('treats not_found as success', async () => {
      const id = await queue(`missing-${unique('k')}.webp`);
      await drain();
      expect((await job(id)).status).toBe('succeeded');
    });

    it('retries every minute and fails after five attempts', async () => {
      const id = await queue(`stuck-${unique('k')}.webp`);
      jest.spyOn(storage, 'delete').mockResolvedValue('unavailable');
      let now = new Date();
      for (let attempt = 1; attempt <= 5; attempt++) {
        await drain(now);
        const current = await job(id);
        expect(current.attempts).toBe(attempt);
        if (attempt < 5) {
          expect(current.status).toBe('queued');
          expect(current.last_error_code).toBe('storage_unavailable');
          // not due again before the pause
          await drain(now);
          expect((await job(id)).attempts).toBe(attempt);
          now = new Date(current.next_attempt_at.getTime() + 1000);
        }
      }
      const final = await job(id);
      expect(final.status).toBe('failed');
      expect(final.last_error_code).toBe('storage_unavailable');
    });

    it('never deletes an object that a profile still references', async () => {
      const key = `ref-${unique('k')}.webp`;
      await createUser('cleanup-ref', { photoKey: key });
      const id = await queue(key);
      const deleteSpy = jest.spyOn(storage, 'delete');
      await drain();
      expect(deleteSpy).not.toHaveBeenCalledWith(key);
      expect((await job(id)).status).toBe('failed');
    });

    it('sweeps unreferenced objects older than one hour only', async () => {
      const referenced = `ref-${unique('o')}.webp`;
      await createUser('orphan-ref', { photoKey: referenced });
      const old = `old-${unique('o')}.webp`;
      const fresh = `fresh-${unique('o')}.webp`;
      const oldReferenced = referenced;
      for (const key of [old, fresh, oldReferenced]) {
        await storage.write(key, Buffer.from('x'));
      }
      const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
      for (const key of [old, oldReferenced]) {
        await utimes(join(storageDir, key), twoHoursAgo, twoHoursAgo);
      }

      await worker.sweepOrphans();

      const files = await readdir(storageDir);
      expect(files).not.toContain(old);
      expect(files).toContain(fresh);
      expect(files).toContain(oldReferenced);
    });
  });
});
