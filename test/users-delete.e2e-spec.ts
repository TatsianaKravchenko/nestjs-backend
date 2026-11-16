/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
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
import { DeletionWorker } from '../src/modules/users/deletion/services/deletion-worker.service';
import { UserEraserRegistry } from '../src/modules/users/deletion/services/user-eraser.registry';
import { LocalPhotoStorage } from '../src/modules/users/storage/local-photo-storage';

// Must not start with "e2e-" (the registration e2e deletes 'e2e-%' users).
const PREFIX = 'delete-spec';
const DOMAIN = '@example.test';
let counter = 0;
const unique = (label: string) =>
  `${PREFIX}-${label}-${Date.now()}-${counter++}`;
const MISSING_UUID = '00000000-0000-4000-8000-0000000000cc';
const PASSWORD = 'Passw0rd-delete-spec';

type TestApp = NestFastifyApplication & { db: DataSource };
let transactionalReady = false;

const env: Record<string, string> = {
  REGISTRATION_CONFIRMATION_ENABLED: 'false',
  API_PUBLIC_URL: 'https://api.test',
  DELETION_CONFIRMATION_METHOD: 'otp',
  DELETION_WORKER_ENABLED: 'false',
  STORAGE_CLEANUP_WORKER_ENABLED: 'false',
  DELETION_EMAIL_HOURLY_LIMIT: '1000',
  DELETION_STATUS_LIMIT: '100000',
};
const mail = {
  sendRegistrationOtp: jest.fn(),
  sendRegistrationMagicLink: jest.fn(),
  sendEmailChangeOtp: jest.fn(),
  sendEmailChangeMagicLink: jest.fn(),
  sendDeletionOtp: jest.fn(),
  sendDeletionMagicLink: jest.fn(),
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

const newKey = () =>
  [...Array(32)]
    .map(() => Math.floor(Math.random() * 16).toString(16))
    .join('');

describe('User deletion (e2e)', () => {
  let app: TestApp;
  let storageDir: string;
  let worker: DeletionWorker;
  let userRole: string;
  let adminRole: string;
  let managerRole: string;
  const created: string[] = [];

  const bump = () =>
    app.db.query(
      'UPDATE rbac_policy_state SET version = version + 1 WHERE id = 1',
    );

  async function createUser(
    label: string,
    options: {
      status?: string;
      photoKey?: string | null;
      displayName?: string | null;
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
    created.push(rows[0].id);
    for (const roleId of options.roles ?? [userRole]) {
      await app.db.query(
        'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
        [rows[0].id, roleId],
      );
    }
    await bump();
    return rows[0].id;
  }

  const row = async (id: string) =>
    (await app.db.query('SELECT * FROM users WHERE id = $1', [id]))[0];
  const jobOf = async (userId: string) =>
    (
      await app.db.query('SELECT * FROM deletion_jobs WHERE user_id = $1', [
        userId,
      ])
    )[0];

  async function send(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    as: string | undefined,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      remoteAddress?: string;
    } = {},
  ) {
    const headers: Record<string, string> = { ...options.headers };
    if (as) {
      const { access } = await app
        .get(TokenService, { strict: false })
        .issuePair(as);
      headers.cookie = `access_token=${access}`;
    }
    return app.inject({
      method,
      url,
      headers,
      remoteAddress: options.remoteAddress,
      payload: options.body as Record<string, unknown> | undefined,
    });
  }

  const lastOtp = (): string => {
    const calls = mail.sendDeletionOtp.mock.calls;
    return calls[calls.length - 1][1] as string;
  };

  /** Starts a challenge for `id` and returns what the client needs to confirm. */
  async function challenge(id: string) {
    const res = await send('POST', `/users/${id}/deletion-challenge`, id);
    expect(res.statusCode).toBe(202);
    return { challengeId: res.json().challengeId as string, code: lastOtp() };
  }

  const confirm = (
    id: string,
    body: unknown,
    key: string | undefined = newKey(),
    as: string | undefined = id,
  ) =>
    send('POST', `/users/${id}/deletion-confirm`, as, {
      body,
      headers: key ? { 'idempotency-key': key } : {},
    });

  /** Self deletion up to the accepted job; returns the receipt. */
  async function selfDelete(id: string): Promise<string> {
    const { challengeId, code } = await challenge(id);
    const key = newKey();
    const res = await confirm(id, { challengeId, code }, key);
    expect(res.statusCode).toBe(202);
    return key;
  }

  const drain = async (now = new Date()) => {
    for (let i = 0; i < 20; i++) {
      if ((await worker.processDue(now)) === 0) return;
    }
  };

  const statusByReceipt = (id: string, receipt: string, ip?: string) =>
    send('GET', `/users/${id}/deletion-status`, undefined, {
      headers: { 'deletion-receipt': receipt },
      remoteAddress: ip,
    });

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'delete-e2e-'));
    app = await createApp(storageDir);
    worker = app.get(DeletionWorker);

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
    userRole = await role('user', [['users', ['read', 'update', 'delete']]]);
    adminRole = await role('admin', [
      ['users', ['read', 'update', 'delete', 'delete_any']],
    ]);
    managerRole = await role('manager', [
      ['users', ['read', 'update', 'delete', 'delete_any']],
      ['rbac', ['manage']],
    ]);
    await bump();
  });

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app.db.query('DELETE FROM deletion_jobs WHERE user_id = ANY($1)', [
      created,
    ]);
    await app.db.query('DELETE FROM user_roles WHERE user_id = ANY($1)', [
      created,
    ]);
    await app.db.query(
      `DELETE FROM role_grants WHERE role_id IN
         (SELECT id FROM roles WHERE name LIKE '${PREFIX}-%')`,
    );
    await app.db.query(`DELETE FROM roles WHERE name LIKE '${PREFIX}-%'`);
    await app.db.query('DELETE FROM users WHERE id = ANY($1)', [created]);
    await app.db.query(
      `DELETE FROM users WHERE email LIKE '${PREFIX}-%${DOMAIN}'`,
    );
    await bump();
    await app.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  /* ------------------------- challenge and confirm ------------------------- */

  describe('POST /users/:id/deletion-challenge', () => {
    it('sends a 6-digit OTP to the current email and never returns the secret', async () => {
      const id = await createUser('challenge');
      const res = await send('POST', `/users/${id}/deletion-challenge`, id);

      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({
        confirmationRequired: true,
        method: 'otp',
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });
      expect(JSON.stringify(res.json())).not.toContain(lastOtp());
      expect(lastOtp()).toMatch(/^\d{6}$/);
      expect(mail.sendDeletionOtp.mock.calls[0][0]).toBe((await row(id)).email);
    });

    it('sends the magic link token in the URL fragment, never the query', async () => {
      env.DELETION_CONFIRMATION_METHOD = 'magic_link';
      try {
        const id = await createUser('magic');
        const res = await send('POST', `/users/${id}/deletion-challenge`, id);
        expect(res.statusCode).toBe(202);
        const url = new URL(mail.sendDeletionMagicLink.mock.calls[0][1]);
        expect(url.search).toBe('');
        const token = url.hash.replace('#token=', '');
        const [challengeId, secret] = token.split('.');
        expect(challengeId).toBe(res.json().challengeId);
        expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);

        const key = newKey();
        const done = await confirm(id, { token }, key);
        expect(done.statusCode).toBe(202);
        expect(done.json().jobId).toBe(key);
      } finally {
        env.DELETION_CONFIRMATION_METHOD = 'otp';
      }
    });

    it('answers 401 without a session and 403 for a foreign id', async () => {
      const id = await createUser('auth-self');
      const other = await createUser('auth-other');
      expect(
        (await send('POST', `/users/${id}/deletion-challenge`, undefined))
          .statusCode,
      ).toBe(401);
      const foreign = await send(
        'POST',
        `/users/${other}/deletion-challenge`,
        id,
      );
      expect(foreign.statusCode).toBe(403);
      expect(mail.sendDeletionOtp).not.toHaveBeenCalled();
    });

    it('requires users@delete', async () => {
      const noDelete = await app.db.query(
        'INSERT INTO roles (name) VALUES ($1) RETURNING id',
        [unique('nodelete')],
      );
      const id = await createUser('no-delete', { roles: [noDelete[0].id] });
      const res = await send('POST', `/users/${id}/deletion-challenge`, id);
      expect(res.statusCode).toBe(403);
      await app.db.query('DELETE FROM user_roles WHERE role_id = $1', [
        noDelete[0].id,
      ]);
      await app.db.query('DELETE FROM roles WHERE id = $1', [noDelete[0].id]);
    });

    it('enforces the 60 s resend pause (429)', async () => {
      const id = await createUser('pause');
      expect(
        (await send('POST', `/users/${id}/deletion-challenge`, id)).statusCode,
      ).toBe(202);
      const again = await send('POST', `/users/${id}/deletion-challenge`, id);
      expect(again.statusCode).toBe(429);
      expect(again.json().retryAfterSeconds).toBeGreaterThan(0);
      expect(mail.sendDeletionOtp).toHaveBeenCalledTimes(1);
    });

    it('allows 5 emails per user and hour (429 afterwards)', async () => {
      env.DELETION_EMAIL_HOURLY_LIMIT = '2';
      try {
        const id = await createUser('hourly');
        const first = await challenge(id);
        // Move the pause out of the way so only the hourly budget can refuse.
        await app.db.query(
          `UPDATE deletion_challenges SET last_sent_at = now() - interval '2 minutes' WHERE user_id = $1`,
          [id],
        );
        const resend = await send(
          'POST',
          `/users/${id}/deletion-challenge/resend`,
          id,
          { body: { challengeId: first.challengeId } },
        );
        expect(resend.statusCode).toBe(202);
        await app.db.query(
          `UPDATE deletion_challenges SET last_sent_at = now() - interval '2 minutes' WHERE user_id = $1`,
          [id],
        );
        const third = await send(
          'POST',
          `/users/${id}/deletion-challenge/resend`,
          id,
          { body: { challengeId: first.challengeId } },
        );
        expect(third.statusCode).toBe(429);
      } finally {
        env.DELETION_EMAIL_HOURLY_LIMIT = '1000';
      }
    });

    it('answers 503 with no secret when SMTP fails, and the challenge can be resent', async () => {
      const id = await createUser('smtp');
      mail.sendDeletionOtp.mockRejectedValueOnce(new Error('smtp down'));
      const res = await send('POST', `/users/${id}/deletion-challenge`, id);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({
        confirmationRequired: true,
        method: 'otp',
      });
      expect(JSON.stringify(res.json())).not.toContain(
        mail.sendDeletionOtp.mock.calls[0][1],
      );
      await app.db.query(
        `UPDATE deletion_challenges SET last_sent_at = now() - interval '2 minutes' WHERE user_id = $1`,
        [id],
      );
      const resend = await send(
        'POST',
        `/users/${id}/deletion-challenge/resend`,
        id,
        { body: { challengeId: res.json().challengeId } },
      );
      expect(resend.statusCode).toBe(202);
    });
  });

  describe('POST /users/:id/deletion-confirm', () => {
    it('accepts the deletion: 202 with jobId = key and a path-only statusUrl', async () => {
      const id = await createUser('confirm', {
        roles: [userRole, adminRole],
      });
      const { challengeId, code } = await challenge(id);
      const key = newKey();
      const res = await confirm(id, { challengeId, code }, key);

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({
        jobId: key,
        statusUrl: `/users/${id}/deletion-status`,
        status: 'queued',
      });
      expect(res.json().statusUrl).not.toContain(key);
      const cookies = [res.headers['set-cookie']].flat().join(';');
      expect(cookies).toContain('access_token=;');
      expect(cookies).toContain('Max-Age=0');

      expect((await row(id)).status).toBe('deleting');
      expect(
        (
          await app.db.query('SELECT 1 FROM user_roles WHERE user_id = $1', [
            id,
          ])
        ).length,
      ).toBe(0);
      expect((await jobOf(id)).id).toBe(key);
      // Every token stops working at once.
      expect((await send('GET', `/users/${id}`, id)).statusCode).toBe(401);
    });

    it('requires a valid Idempotency-Key (400)', async () => {
      const id = await createUser('key');
      const { challengeId, code } = await challenge(id);
      for (const key of [undefined, 'short', 'Z'.repeat(32), 'A'.repeat(32)]) {
        const res = await confirm(id, { challengeId, code }, key ?? '');
        expect(res.statusCode).toBe(400);
      }
      expect((await row(id)).status).toBe('active');
    });

    it('rejects unknown fields and an empty body (400)', async () => {
      const id = await createUser('shape');
      const { challengeId, code } = await challenge(id);
      expect((await confirm(id, {})).statusCode).toBe(400);
      expect(
        (await confirm(id, { challengeId, code, extra: 1 })).statusCode,
      ).toBe(400);
      expect(
        (await confirm(id, { challengeId, code, token: 'x' })).statusCode,
      ).toBe(400);
    });

    it('consumes the challenge on the 5th wrong code (400) and answers 429 afterwards', async () => {
      const id = await createUser('wrong');
      const { challengeId, code } = await challenge(id);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) {
        const res = await confirm(id, { challengeId, code: wrong });
        expect(res.statusCode).toBe(400);
      }
      const reason = (
        await app.db.query(
          'SELECT consumed_reason FROM deletion_challenges WHERE id = $1',
          [challengeId],
        )
      )[0].consumed_reason;
      expect(reason).toBe('attempts_exhausted');
      const after = await confirm(id, { challengeId, code });
      expect(after.statusCode).toBe(429);
      expect((await row(id)).status).toBe('active');
    });

    it('rejects an expired challenge and one from another user (400)', async () => {
      const id = await createUser('expired');
      const other = await createUser('foreign-challenge');
      const first = await challenge(id);
      await app.db.query(
        `UPDATE deletion_challenges SET last_sent_at = now() - interval '11 minutes' WHERE id = $1`,
        [first.challengeId],
      );
      expect((await confirm(id, first)).statusCode).toBe(400);

      const second = await challenge(other);
      expect((await confirm(id, second)).statusCode).toBe(400);
      expect((await row(id)).status).toBe('active');
    });

    it('returns 409 when the same Idempotency-Key was used for another user', async () => {
      const first = await createUser('key-owner');
      const second = await createUser('key-thief');
      const key = await selfDelete(first);

      const { challengeId, code } = await challenge(second);
      const res = await confirm(second, { challengeId, code }, key);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('idempotency_key_conflict');
      expect((await row(second)).status).toBe('active');
    });

    it('returns the existing job (202) for another key of the same user and spends the challenge as job_exists', async () => {
      const id = await createUser('job-exists');
      const existing = newKey();
      await app.db.query(
        `INSERT INTO deletion_jobs (id, user_id, status, tombstone_email, next_attempt_at)
         VALUES ($1, $2, 'queued', $3, now() + interval '1 day')`,
        [existing, id, `deleted-${existing}@example.invalid`],
      );
      const { challengeId, code } = await challenge(id);
      const res = await confirm(id, { challengeId, code }, newKey());

      expect(res.statusCode).toBe(202);
      expect(res.json().jobId).toBe(existing);
      const reason = (
        await app.db.query(
          'SELECT consumed_reason FROM deletion_challenges WHERE id = $1',
          [challengeId],
        )
      )[0].consumed_reason;
      expect(reason).toBe('job_exists');
    });

    it('survives a lost 202: the receipt is the Idempotency-Key', async () => {
      const id = await createUser('lost');
      const key = await selfDelete(id);

      // The retry has no valid session any more (the user is `deleting`).
      const retry = await confirm(
        id,
        { challengeId: MISSING_UUID, code: '123456' },
        key,
      );
      expect(retry.statusCode).toBe(401);
      const status = await statusByReceipt(id, key);
      expect(status.statusCode).toBe(200);
      expect(status.json()).toEqual({ status: 'queued' });
    });

    it('keeps the last active rbac@manage user (409)', async () => {
      const actor = await createUser('last-mgr', { roles: [managerRole] });
      const others: { id: string }[] = await app.db.query(
        `SELECT DISTINCT u.id FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN role_grants g ON g.role_id = ur.role_id
           JOIN permissions p ON p.id = g.permission_id
          WHERE u.status = 'active' AND p.name = 'rbac' AND u.id <> $1`,
        [actor],
      );
      const ids = others.map((o) => o.id);
      if (ids.length) {
        await app.db.query(
          `UPDATE users SET status = 'blocked' WHERE id = ANY($1)`,
          [ids],
        );
      }
      try {
        const { challengeId, code } = await challenge(actor);
        const res = await confirm(actor, { challengeId, code });
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('last_access_manager');
        expect((await row(actor)).status).toBe('active');
        expect(await jobOf(actor)).toBeUndefined();
      } finally {
        if (ids.length) {
          await app.db.query(
            `UPDATE users SET status = 'active' WHERE id = ANY($1)`,
            [ids],
          );
        }
      }
    });
  });

  /* ------------------------------- DELETE ------------------------------- */

  describe('DELETE /users/:id', () => {
    it('lets an administrator accept a deletion (202) and repeats return the same job', async () => {
      const admin = await createUser('admin', { roles: [adminRole] });
      const target = await createUser('target');

      const res = await send('DELETE', `/users/${target}`, admin);
      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.jobId).toMatch(/^[0-9a-f]{32}$/);
      expect(body.statusUrl).toBe(`/users/${target}/deletion-status`);
      expect((await row(target)).status).toBe('deleting');
      expect((await send('GET', `/users/${target}`, target)).statusCode).toBe(
        401,
      );

      const again = await send('DELETE', `/users/${target}`, admin);
      expect(again.statusCode).toBe(202);
      expect(again.json().jobId).toBe(body.jobId);
    });

    it('serializes concurrent deletes to one job', async () => {
      const admin = await createUser('race-admin', { roles: [adminRole] });
      const target = await createUser('race-target');
      const [a, b] = await Promise.all([
        send('DELETE', `/users/${target}`, admin),
        send('DELETE', `/users/${target}`, admin),
      ]);
      expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
      expect(a.json().jobId).toBe(b.json().jobId);
      expect(
        (
          await app.db.query(
            'SELECT count(*)::int AS n FROM deletion_jobs WHERE user_id = $1',
            [target],
          )
        )[0].n,
      ).toBe(1);
    });

    it('refuses the own id with self_confirmation_required (403)', async () => {
      const admin = await createUser('self-admin', { roles: [adminRole] });
      const res = await send('DELETE', `/users/${admin}`, admin);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('self_confirmation_required');
      expect((await row(admin)).status).toBe('active');
    });

    it('needs users@delete_any before the target is looked up', async () => {
      const plain = await createUser('plain');
      const target = await createUser('plain-target');
      expect((await send('DELETE', `/users/${target}`, plain)).statusCode).toBe(
        403,
      );
      // A missing user is also 403 for a caller without the permission.
      expect(
        (await send('DELETE', `/users/${MISSING_UUID}`, plain)).statusCode,
      ).toBe(403);
      expect((await row(target)).status).toBe('active');
      expect(
        (await send('DELETE', `/users/${target}`, undefined)).statusCode,
      ).toBe(401);
    });

    it('answers 404 for an unknown user and 400 for a malformed id', async () => {
      const admin = await createUser('admin-404', { roles: [adminRole] });
      expect(
        (await send('DELETE', `/users/${MISSING_UUID}`, admin)).statusCode,
      ).toBe(404);
      expect(
        (await send('DELETE', `/users/${'x'.repeat(129)}`, admin)).statusCode,
      ).toBe(400);
    });

    it('deletes a pending user like any other (202), with open registration attempts cancelled', async () => {
      const admin = await createUser('pend-admin', { roles: [adminRole] });
      const pending = await createUser('pending', {
        status: 'pending',
        roles: [],
      });
      await app.db.query(
        `INSERT INTO registration_attempts (user_id, method, secret_hash, expires_at, last_sent_at)
         VALUES ($1, 'otp', $2, now() + interval '10 minutes', now())`,
        [pending, 'h'.repeat(64)],
      );

      const res = await send('DELETE', `/users/${pending}`, admin);
      expect(res.statusCode).toBe(202);
      expect(res.json().jobId).toMatch(/^[0-9a-f]{32}$/);
      expect((await row(pending)).status).toBe('deleting');
      expect(
        (
          await app.db.query(
            'SELECT 1 FROM registration_attempts WHERE user_id = $1 AND consumed_at IS NULL',
            [pending],
          )
        ).length,
      ).toBe(0);

      await drain();
      const after = await row(pending);
      expect(after.status).toBe('deleted');
      expect(after.email).toMatch(/@example.invalid$/);
    });

    it('answers 503 for a deleted user without a job (inconsistent state)', async () => {
      const admin = await createUser('gone-admin', { roles: [adminRole] });
      const gone = await createUser('gone', { status: 'deleted' });
      const res = await send('DELETE', `/users/${gone}`, admin);
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe('service_unavailable');
      expect((await row(gone)).status).toBe('deleted');
    });

    it('refuses to delete the last active rbac@manage user (409)', async () => {
      const actor = await createUser('del-actor', { roles: [adminRole] });
      const holder = await createUser('del-holder', { roles: [managerRole] });
      const others: { id: string }[] = await app.db.query(
        `SELECT DISTINCT u.id FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN role_grants g ON g.role_id = ur.role_id
           JOIN permissions p ON p.id = g.permission_id
          WHERE u.status = 'active' AND p.name = 'rbac' AND u.id <> $1`,
        [holder],
      );
      const ids = others.map((o) => o.id);
      if (ids.length) {
        await app.db.query(
          `UPDATE users SET status = 'blocked' WHERE id = ANY($1)`,
          [ids],
        );
      }
      try {
        const res = await send('DELETE', `/users/${holder}`, actor);
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('last_access_manager');
        expect((await row(holder)).status).toBe('active');
      } finally {
        if (ids.length) {
          await app.db.query(
            `UPDATE users SET status = 'active' WHERE id = ANY($1)`,
            [ids],
          );
        }
      }
    });

    it('cancels open login, email change and deletion challenges', async () => {
      const admin = await createUser('cancel-admin', { roles: [adminRole] });
      const target = await createUser('cancel-target');
      await challenge(target);
      await send('DELETE', `/users/${target}`, admin);
      const open = await app.db.query(
        `SELECT 1 FROM deletion_challenges WHERE user_id = $1 AND consumed_at IS NULL`,
        [target],
      );
      expect(open.length).toBe(0);
    });
  });

  /* -------------------------------- status -------------------------------- */

  describe('GET /users/:id/deletion-status', () => {
    it('self branch: the receipt is enough and cookies are not read', async () => {
      const id = await createUser('status-self');
      const key = await selfDelete(id);
      const res = await statusByReceipt(id, key);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'queued' });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('answers the same 404 for a wrong, malformed or unknown receipt and unknown target', async () => {
      const id = await createUser('status-404');
      const other = await createUser('status-404-other');
      await selfDelete(id);
      const otherKey = await selfDelete(other);

      const bodies = new Set<string>();
      for (const [target, receipt] of [
        [id, newKey()],
        [id, 'not-hex'],
        [id, otherKey],
        [MISSING_UUID, newKey()],
        ['not-a-uuid', newKey()],
      ]) {
        const res = await statusByReceipt(target, receipt);
        expect(res.statusCode).toBe(404);
        bodies.add(res.json().code);
      }
      expect([...bodies]).toEqual(['not_found']);
    });

    it('administrator branch needs a session and both delete permissions', async () => {
      const admin = await createUser('status-admin', { roles: [adminRole] });
      const plain = await createUser('status-plain');
      const target = await createUser('status-target');
      await send('DELETE', `/users/${target}`, admin);

      const ok = await send('GET', `/users/${target}/deletion-status`, admin);
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ status: 'queued' });
      expect(
        (await send('GET', `/users/${target}/deletion-status`, plain))
          .statusCode,
      ).toBe(403);
      expect(
        (await send('GET', `/users/${target}/deletion-status`, undefined))
          .statusCode,
      ).toBe(401);
      expect(
        (await send('GET', `/users/${MISSING_UUID}/deletion-status`, admin))
          .statusCode,
      ).toBe(404);
    });

    it('limits status reads per IP (429)', async () => {
      env.DELETION_STATUS_LIMIT = '3';
      try {
        const codes: number[] = [];
        for (let i = 0; i < 4; i++) {
          codes.push(
            (await statusByReceipt(MISSING_UUID, newKey(), '10.20.30.40'))
              .statusCode,
          );
        }
        expect(codes).toEqual([404, 404, 404, 429]);
        // Another address is unaffected.
        expect(
          (await statusByReceipt(MISSING_UUID, newKey(), '10.20.30.41'))
            .statusCode,
        ).toBe(404);
      } finally {
        env.DELETION_STATUS_LIMIT = '100000';
      }
    });
  });

  /* -------------------------------- worker -------------------------------- */

  describe('deletion worker', () => {
    it('erases the user: tombstone email, no name, photo or password, status deleted', async () => {
      const storage = new LocalPhotoStorage({ get: () => storageDir } as never);
      const photoKey = `${unique('photo')}.webp`;
      await storage.write(photoKey, Buffer.from('webp-bytes'));
      expect(await readdir(storageDir)).toContain(photoKey);

      const id = await createUser('erase', {
        photoKey,
        displayName: 'Erase Me',
      });
      const before = (await row(id)).email;
      const key = await selfDelete(id);
      await drain();

      const after = await row(id);
      expect(after.status).toBe('deleted');
      expect(after.email).toMatch(/^deleted-[0-9a-f]{32}@example\.invalid$/);
      expect(after.email).not.toBe(before);
      expect(after.display_name).toBeNull();
      expect(after.photo_key).toBeNull();
      expect(after.password_hash).toBeNull();
      expect(await readdir(storageDir)).not.toContain(photoKey);
      expect((await jobOf(id)).status).toBe('succeeded');
      for (const table of [
        'registration_attempts',
        'login_attempts',
        'email_change_challenges',
        'deletion_challenges',
      ]) {
        expect(
          (
            await app.db.query(
              `SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`,
              [id],
            )
          )[0].n,
        ).toBe(0);
      }
      const status = await statusByReceipt(id, key);
      expect(status.json()).toEqual({ status: 'succeeded' });
    });

    it('gives every deleted user a unique tombstone and frees the old address', async () => {
      const a = await createUser('tomb-a');
      const b = await createUser('tomb-b');
      const emailA = (await row(a)).email;
      await selfDelete(a);
      await selfDelete(b);
      await drain();

      const rows = await app.db.query(
        'SELECT email FROM users WHERE id = ANY($1)',
        [[a, b]],
      );
      expect(new Set(rows.map((r: { email: string }) => r.email)).size).toBe(2);

      // The address can be registered again.
      const res = await send('POST', '/auth/register', undefined, {
        body: { email: emailA, password: PASSWORD },
      });
      expect(res.statusCode).toBeLessThan(300);
      const registered = await app.db.query(
        'SELECT id, status FROM users WHERE email = $1',
        [emailA],
      );
      expect(registered).toHaveLength(1);
      expect(registered[0].id).not.toBe(a);
      created.push(registered[0].id);
    });

    it('retries a failing eraser every minute and keeps the user deleting until it works', async () => {
      const storage = new LocalPhotoStorage({ get: () => storageDir } as never);
      const photoKey = `${unique('retry')}.webp`;
      await storage.write(photoKey, Buffer.from('bytes'));
      const id = await createUser('retry', { photoKey });
      await selfDelete(id);

      const spy = jest
        .spyOn(LocalPhotoStorage.prototype, 'delete')
        .mockResolvedValue('unavailable');
      const now = Date.now();
      await drain(new Date(now));
      const job = await jobOf(id);
      expect(job.status).toBe('queued');
      expect(job.attempts).toBe(1);
      expect(job.last_error_code).toBe('storage_unavailable');
      expect((await row(id)).status).toBe('deleting');

      // Not due before the pause is over.
      await drain(new Date(now + 30_000));
      expect((await jobOf(id)).attempts).toBe(1);

      spy.mockRestore();
      await drain(new Date(now + 61_000));
      expect((await row(id)).status).toBe('deleted');
      expect((await jobOf(id)).status).toBe('succeeded');
    });

    it('fails after 5 runs, keeps the user deleting and lets an administrator queue it again', async () => {
      const admin = await createUser('retry-admin', { roles: [adminRole] });
      const storage = new LocalPhotoStorage({ get: () => storageDir } as never);
      const photoKey = `${unique('failed')}.webp`;
      await storage.write(photoKey, Buffer.from('bytes'));
      const id = await createUser('failed', { photoKey });
      const key = await selfDelete(id);

      const spy = jest
        .spyOn(LocalPhotoStorage.prototype, 'delete')
        .mockResolvedValue('unavailable');
      const now = Date.now();
      for (let run = 0; run < 5; run++) {
        await drain(new Date(now + run * 61_000));
      }
      const job = await jobOf(id);
      expect(job.status).toBe('failed');
      expect(job.attempts).toBe(5);
      expect((await row(id)).status).toBe('deleting');
      expect((await statusByReceipt(id, key)).json()).toEqual({
        status: 'failed',
      });

      spy.mockRestore();
      const requeue = await send('DELETE', `/users/${id}`, admin);
      expect(requeue.statusCode).toBe(202);
      expect(requeue.json()).toMatchObject({ jobId: key, status: 'queued' });
      expect(
        (
          await app.db.query(
            'SELECT count(*)::int AS n FROM deletion_jobs WHERE user_id = $1',
            [id],
          )
        )[0].n,
      ).toBe(1);
      await drain(new Date(now + 400_000));
      expect((await row(id)).status).toBe('deleted');
    });

    it('does not finalize while the photo object is still present', async () => {
      const storage = new LocalPhotoStorage({ get: () => storageDir } as never);
      const photoKey = `${unique('present')}.webp`;
      await storage.write(photoKey, Buffer.from('bytes'));
      const id = await createUser('present', { photoKey });
      await selfDelete(id);

      // The eraser claims success but the object is still there.
      jest
        .spyOn(LocalPhotoStorage.prototype, 'delete')
        .mockResolvedValue('deleted');
      await drain();
      const job = await jobOf(id);
      expect(job.status).toBe('queued');
      expect(job.last_error_code).toBe('photo_present');
      expect((await row(id)).status).toBe('deleting');
      expect((await row(id)).photo_key).toBe(photoKey);
    });

    it('is safe to run twice in parallel (lease and SKIP LOCKED)', async () => {
      const id = await createUser('parallel');
      await selfDelete(id);
      await Promise.all([worker.processDue(), worker.processDue()]);
      expect((await row(id)).status).toBe('deleted');
      expect((await jobOf(id)).attempts).toBe(1);
    });

    it('picks up a running job whose lease expired', async () => {
      const id = await createUser('lease');
      await selfDelete(id);
      await app.db.query(
        `UPDATE deletion_jobs SET status = 'running', attempts = 1,
                lease_until = now() - interval '1 minute' WHERE user_id = $1`,
        [id],
      );
      await drain();
      expect((await row(id)).status).toBe('deleted');
      expect((await jobOf(id)).attempts).toBe(2);
    });
  });

  /* ------------------------- readiness and the registry ------------------------- */

  describe('readiness', () => {
    it('is ready only with every data store covered by an eraser', async () => {
      const registry = app.get(UserEraserRegistry);
      expect(registry.missing()).toEqual([]);
      const ready = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().info).toHaveProperty('deletion_erasers');
      expect(ready.json().info).toHaveProperty('deletion_key');

      jest.spyOn(registry, 'missing').mockReturnValue(['billing.invoices']);
      const down = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(down.statusCode).toBe(503);
      expect(JSON.stringify(down.json())).toContain('billing.invoices');
    });
  });
});
