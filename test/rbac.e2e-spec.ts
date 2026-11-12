/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { AppModule } from '../src/core/app/app.module';
import { ConfigService } from '../src/core/config/config.service';
import { MailService } from '../src/modules/auth/services/mail.service';
import { TokenService } from '../src/modules/auth/services/token.service';

// Must not start with "e2e-": auth-registration.e2e-spec.ts deletes 'e2e-%' users in parallel.
const PREFIX = 'rbac-spec';
const DOMAIN = '@example.test';
let counter = 0;
const unique = (label: string) =>
  `${PREFIX}-${label}-${Date.now()}-${counter++}`;

type TestApp = NestFastifyApplication & { db: DataSource };

let transactionalReady = false;

/** Requests authenticate with a real access token cookie, like a signed-in browser. */
async function createApp(): Promise<TestApp> {
  if (!transactionalReady) {
    initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });
    transactionalReady = true;
  }

  const env: Record<string, string> = {
    REGISTRATION_CONFIRMATION_ENABLED: 'false',
    REGISTRATION_THROTTLE_LIMIT: '1000',
    REGISTRATION_THROTTLE_TTL: '60000',
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
    new FastifyAdapter(),
  ) as TestApp;
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  app.db = app.get(DataSource);
  return app;
}

describe('RBAC admin API (e2e)', () => {
  let app: TestApp;
  let adminId: string;
  let plainUserId: string;
  let adminRoleId: string;

  const call = async (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    options: { user?: string; payload?: object } = {},
  ) => {
    const headers: Record<string, string> = {};
    if (options.user) {
      const { access } = await app
        .get(TokenService, { strict: false })
        .issuePair(options.user);
      headers.cookie = `access_token=${access}`;
    }
    return app.inject({ method, url, payload: options.payload, headers });
  };

  const asAdmin = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
  ) => call(method, url, { user: adminId, payload });

  async function createUser(label: string): Promise<string> {
    const rows: { id: string }[] = await app.db.query(
      `INSERT INTO users (email, password_hash, status)
       VALUES ($1, 'x', 'active') RETURNING id`,
      [`${unique(label)}${DOMAIN}`],
    );
    return rows[0].id;
  }

  async function bumpVersion() {
    await app.db.query(
      'UPDATE rbac_policy_state SET version = version + 1 WHERE id = 1',
    );
  }

  beforeAll(async () => {
    app = await createApp();

    // An admin that holds rbac@manage through its own role, independent of bootstrap.
    await app.db.query(
      `INSERT INTO permissions (name, actions) VALUES ('rbac', '{manage}')
       ON CONFLICT (name) DO NOTHING`,
    );
    const roles: { id: string }[] = await app.db.query(
      `INSERT INTO roles (name) VALUES ($1) RETURNING id`,
      [unique('admin')],
    );
    adminRoleId = roles[0].id;
    await app.db.query(
      `INSERT INTO role_grants (role_id, permission_id, all_actions)
       SELECT $1, id, true FROM permissions WHERE name = 'rbac'`,
      [adminRoleId],
    );
    adminId = await createUser('admin');
    plainUserId = await createUser('plain');
    await app.db.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
      [adminId, adminRoleId],
    );
    await bumpVersion();
  });

  afterAll(async () => {
    await app.db.query(
      `DELETE FROM user_roles WHERE user_id IN
         (SELECT id FROM users WHERE email LIKE '${PREFIX}-%${DOMAIN}')`,
    );
    await app.db.query(
      `DELETE FROM role_grants WHERE role_id IN
         (SELECT id FROM roles WHERE name LIKE '${PREFIX}-%')
         OR permission_id IN (SELECT id FROM permissions WHERE name LIKE '${PREFIX}-%')`,
    );
    await app.db.query(`DELETE FROM roles WHERE name LIKE '${PREFIX}-%'`);
    await app.db.query(`DELETE FROM permissions WHERE name LIKE '${PREFIX}-%'`);
    await app.db.query(
      `DELETE FROM users WHERE email LIKE '${PREFIX}-%${DOMAIN}'`,
    );
    await bumpVersion();
    await app.close();
  });

  describe('access control', () => {
    it('answers 401 without an authenticated user', async () => {
      const res = await call('GET', '/admin/rbac/roles');

      expect(res.statusCode).toBe(401);
    });

    it('answers 403 to a user without rbac@manage, on every route family', async () => {
      const id = '00000000-0000-4000-8000-000000000000';
      const checks: [Parameters<typeof call>[0], string][] = [
        ['GET', '/admin/rbac/roles'],
        ['POST', '/admin/rbac/roles'],
        ['GET', '/admin/rbac/permissions'],
        ['GET', '/admin/rbac/grants'],
        ['GET', `/admin/rbac/users/${plainUserId}/roles`],
        ['PUT', `/admin/rbac/users/${plainUserId}/roles`],
        // Existence is not revealed: 403, not 404.
        ['GET', `/admin/rbac/roles/${id}`],
        ['DELETE', `/admin/rbac/roles/${id}`],
      ];

      for (const [method, url] of checks) {
        const res = await call(method, url, {
          user: plainUserId,
          payload: method === 'GET' || method === 'DELETE' ? undefined : {},
        });
        expect([method, url, res.statusCode]).toEqual([method, url, 403]);
      }
    });

    it('does not reveal roles in the 403 body', async () => {
      const res = await call('GET', '/admin/rbac/roles', { user: plainUserId });

      expect(res.body).not.toMatch(/admin|role/i);
    });

    it('answers 403 permission_denied for an active user without the permission', async () => {
      const res = await call('GET', '/admin/rbac/roles', { user: plainUserId });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'permission_denied' });
    });

    it('rejects a cross-origin write without the CSRF header, before RBAC', async () => {
      const { access } = await app
        .get(TokenService, { strict: false })
        .issuePair(adminId);
      const res = await app.inject({
        method: 'POST',
        url: '/admin/rbac/roles',
        payload: {},
        headers: {
          cookie: `access_token=${access}`,
          origin: 'https://evil.example',
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'csrf_rejected' });
    });

    it('answers 401 for an inactive user holding a valid token', async () => {
      const blocked = await createUser('inactive');
      await app.db.query(`UPDATE users SET status = 'pending' WHERE id = $1`, [
        blocked,
      ]);

      const res = await call('GET', '/admin/rbac/roles', { user: blocked });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: 'invalid_session' });
    });

    it('answers 401 for a valid token of a user that does not exist', async () => {
      const res = await call('GET', '/admin/rbac/roles', {
        user: '00000000-0000-4000-8000-0000000000ff',
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: 'invalid_session' });
    });

    it('answers 401 for a garbage access token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/rbac/roles',
        headers: { cookie: 'access_token=not-a-jwt' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('answers 401 for a user who is no longer active', async () => {
      await app.db.query("UPDATE users SET status = 'pending' WHERE id = $1", [
        adminId,
      ]);

      const res = await asAdmin('GET', '/admin/rbac/roles');
      await app.db.query("UPDATE users SET status = 'active' WHERE id = $1", [
        adminId,
      ]);

      expect(res.statusCode).toBe(401);
    });
  });

  describe('roles', () => {
    it('creates, reads, replaces and deletes a role', async () => {
      const name = unique('editor');

      const created = await asAdmin('POST', '/admin/rbac/roles', {
        name: name.toUpperCase(),
        description: '  Edits things ',
      });
      expect(created.statusCode).toBe(201);
      const role = created.json();
      expect(role).toEqual({
        id: expect.any(String),
        name,
        description: 'Edits things',
      });

      const list = await asAdmin('GET', '/admin/rbac/roles');
      expect(list.statusCode).toBe(200);
      expect(list.json().map((r: { id: string }) => r.id)).toContain(role.id);

      const fetched = await asAdmin('GET', `/admin/rbac/roles/${role.id}`);
      expect(fetched.json()).toEqual(role);

      const renamed = unique('editor2');
      const replaced = await asAdmin('PUT', `/admin/rbac/roles/${role.id}`, {
        name: renamed,
        description: '',
      });
      expect(replaced.statusCode).toBe(200);
      expect(replaced.json()).toEqual({
        id: role.id,
        name: renamed,
        description: null,
      });

      const deleted = await asAdmin('DELETE', `/admin/rbac/roles/${role.id}`);
      expect(deleted.statusCode).toBe(204);
      expect(deleted.body).toBe('');

      const gone = await asAdmin('GET', `/admin/rbac/roles/${role.id}`);
      expect(gone.statusCode).toBe(404);
    });

    it('rejects a duplicate name (409) and invalid input (400)', async () => {
      const name = unique('dup');
      await asAdmin('POST', '/admin/rbac/roles', { name });

      const duplicate = await asAdmin('POST', '/admin/rbac/roles', { name });
      expect(duplicate.statusCode).toBe(409);

      for (const payload of [
        { name: '' },
        { name: '1bad' },
        { name: 'x'.repeat(65) },
        { name: 'ok', description: 'x'.repeat(501) },
        {},
      ]) {
        const res = await asAdmin('POST', '/admin/rbac/roles', payload);
        expect([payload, res.statusCode]).toEqual([payload, 400]);
      }
    });

    it('answers 400 for a malformed id and 404 for an unknown one', async () => {
      const bad = await asAdmin('GET', '/admin/rbac/roles/not-a-uuid');
      expect(bad.statusCode).toBe(400);

      const unknown = await asAdmin(
        'DELETE',
        '/admin/rbac/roles/00000000-0000-4000-8000-000000000000',
      );
      expect(unknown.statusCode).toBe(404);
    });
  });

  describe('permissions and grants', () => {
    it('manages permissions with unique actions', async () => {
      const name = unique('perm');
      const created = await asAdmin('POST', '/admin/rbac/permissions', {
        name,
        actions: ['Read', 'update'],
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        name,
        actions: ['read', 'update'],
      });

      const duplicates = await asAdmin('POST', '/admin/rbac/permissions', {
        name: unique('perm'),
        actions: ['read', 'READ'],
      });
      expect(duplicates.statusCode).toBe(400);

      const empty = await asAdmin('POST', '/admin/rbac/permissions', {
        name: unique('perm'),
        actions: [],
      });
      expect(empty.statusCode).toBe(400);

      const id = created.json().id;
      const deleted = await asAdmin('DELETE', `/admin/rbac/permissions/${id}`);
      expect(deleted.statusCode).toBe(204);
    });

    it('covers grants: all actions, explicit actions, conflicts and in-use checks', async () => {
      const permission = (
        await asAdmin('POST', '/admin/rbac/permissions', {
          name: unique('perm'),
          actions: ['read', 'update'],
        })
      ).json();
      const allRole = (
        await asAdmin('POST', '/admin/rbac/roles', { name: unique('all') })
      ).json();
      const someRole = (
        await asAdmin('POST', '/admin/rbac/roles', { name: unique('some') })
      ).json();

      // Omitted actions mean all current and future actions.
      const all = await asAdmin('POST', '/admin/rbac/grants', {
        roleId: allRole.id,
        permissionId: permission.id,
      });
      expect(all.statusCode).toBe(201);
      expect(all.json()).toMatchObject({
        allActions: true,
        actions: ['read', 'update'],
      });

      const some = await asAdmin('POST', '/admin/rbac/grants', {
        roleId: someRole.id,
        permissionId: permission.id,
        actions: ['update'],
      });
      expect(some.statusCode).toBe(201);
      expect(some.json()).toMatchObject({
        allActions: false,
        actions: ['update'],
      });

      // One grant per role-permission pair.
      const again = await asAdmin('POST', '/admin/rbac/grants', {
        roleId: someRole.id,
        permissionId: permission.id,
      });
      expect(again.statusCode).toBe(409);

      // Actions must belong to the permission.
      const foreign = await asAdmin(
        'PUT',
        `/admin/rbac/grants/${some.json().id}`,
        {
          roleId: someRole.id,
          permissionId: permission.id,
          actions: ['purge'],
        },
      );
      expect(foreign.statusCode).toBe(400);

      // Unknown references.
      const missing = await asAdmin('POST', '/admin/rbac/grants', {
        roleId: '00000000-0000-4000-8000-000000000000',
        permissionId: permission.id,
      });
      expect(missing.statusCode).toBe(404);

      // An explicit grant blocks removing its action; an all-actions grant does not.
      const removeUsed = await asAdmin(
        'PUT',
        `/admin/rbac/permissions/${permission.id}`,
        { name: permission.name, actions: ['read'] },
      );
      expect(removeUsed.statusCode).toBe(409);

      const addAction = await asAdmin(
        'PUT',
        `/admin/rbac/permissions/${permission.id}`,
        { name: permission.name, actions: ['read', 'update', 'list'] },
      );
      expect(addAction.statusCode).toBe(200);
      const followed = await asAdmin(
        'GET',
        `/admin/rbac/grants/${all.json().id}`,
      );
      expect(followed.json().actions).toEqual(['read', 'update', 'list']);

      // Neither role nor permission can go while grants reference them.
      const roleInUse = await asAdmin(
        'DELETE',
        `/admin/rbac/roles/${allRole.id}`,
      );
      expect(roleInUse.statusCode).toBe(409);
      const permissionInUse = await asAdmin(
        'DELETE',
        `/admin/rbac/permissions/${permission.id}`,
      );
      expect(permissionInUse.statusCode).toBe(409);

      for (const grant of [all, some]) {
        const res = await asAdmin(
          'DELETE',
          `/admin/rbac/grants/${grant.json().id}`,
        );
        expect(res.statusCode).toBe(204);
      }
      expect(
        (await asAdmin('DELETE', `/admin/rbac/permissions/${permission.id}`))
          .statusCode,
      ).toBe(204);
    });
  });

  describe('user roles and policy changes', () => {
    it('applies role changes on the next request, without a restart', async () => {
      const userId = await createUser('delegate');

      // No roles: denied.
      expect(
        (await call('GET', '/admin/rbac/roles', { user: userId })).statusCode,
      ).toBe(403);

      // Granting the admin role takes effect immediately.
      const assigned = await asAdmin(
        'PUT',
        `/admin/rbac/users/${userId}/roles`,
        {
          roleIds: [adminRoleId],
        },
      );
      expect(assigned.statusCode).toBe(200);
      expect(assigned.json()).toEqual({ userId, roleIds: [adminRoleId] });
      expect(
        (await call('GET', '/admin/rbac/roles', { user: userId })).statusCode,
      ).toBe(200);

      const read = await asAdmin('GET', `/admin/rbac/users/${userId}/roles`);
      expect(read.json()).toEqual({ userId, roleIds: [adminRoleId] });

      // An empty list removes all access.
      const cleared = await asAdmin(
        'PUT',
        `/admin/rbac/users/${userId}/roles`,
        {
          roleIds: [],
        },
      );
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json()).toEqual({ userId, roleIds: [] });
      expect(
        (await call('GET', '/admin/rbac/roles', { user: userId })).statusCode,
      ).toBe(403);
    });

    it('picks up a policy change written straight to the database', async () => {
      const userId = await createUser('direct');
      await call('GET', '/admin/rbac/roles', { user: userId }); // snapshot is warm

      await app.db.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
        [userId, adminRoleId],
      );
      await bumpVersion();

      expect(
        (await call('GET', '/admin/rbac/roles', { user: userId })).statusCode,
      ).toBe(200);
    });

    it('rejects duplicate and unknown role ids (400) and an unknown user (404)', async () => {
      const dup = await asAdmin(
        'PUT',
        `/admin/rbac/users/${plainUserId}/roles`,
        {
          roleIds: [adminRoleId, adminRoleId],
        },
      );
      expect(dup.statusCode).toBe(400);

      const unknownRole = await asAdmin(
        'PUT',
        `/admin/rbac/users/${plainUserId}/roles`,
        { roleIds: ['00000000-0000-4000-8000-000000000000'] },
      );
      expect(unknownRole.statusCode).toBe(400);

      const unknownUser = await asAdmin(
        'GET',
        '/admin/rbac/users/00000000-0000-4000-8000-000000000000/roles',
      );
      expect(unknownUser.statusCode).toBe(404);
    });

    it('increments the policy version with every admin change', async () => {
      const before: { version: number }[] = await app.db.query(
        'SELECT version FROM rbac_policy_state WHERE id = 1',
      );

      await asAdmin('POST', '/admin/rbac/roles', { name: unique('versioned') });
      // A rejected change must not bump it.
      await asAdmin('POST', '/admin/rbac/roles', { name: '' });

      const after: { version: number }[] = await app.db.query(
        'SELECT version FROM rbac_policy_state WHERE id = 1',
      );
      expect(after[0].version).toBe(before[0].version + 1);
    });
  });

  describe('default role on activation', () => {
    it('gives a newly registered active user the user role', async () => {
      const email = `${unique('signup')}${DOMAIN}`;

      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email, password: 'Passw0rd-e2e' },
      });
      expect(res.statusCode).toBe(201);

      const roles: { name: string }[] = await app.db.query(
        `SELECT r.name FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = $1`,
        [res.json().id],
      );
      expect(roles.map((r) => r.name)).toEqual(['user']);
    });
  });
});
