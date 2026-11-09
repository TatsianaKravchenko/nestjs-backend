/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
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
import { PasswordService } from '../src/modules/auth/services/password.service';

// Must not start with "e2e-": auth-registration.e2e-spec.ts deletes 'e2e-%' users.
const PREFIX = 'login-e2e';
const DOMAIN = '@example.test';
const PASSWORD = 'Passw0rd-e2e';
const TRUSTED_ORIGIN = 'https://app.example.test';
let counter = 0;
const uniqueEmail = () => `${PREFIX}-${Date.now()}-${counter++}${DOMAIN}`;

interface SentMail {
  email: string;
  secret: string;
}

type TestApp = NestFastifyApplication & { db: DataSource };
type Ctx = Awaited<ReturnType<typeof createApp>>;
type Res = Awaited<ReturnType<TestApp['inject']>>;

let transactionalReady = false;
let passwordHash: string;

async function createApp(env: Record<string, string> = {}, failMail = false) {
  if (!transactionalReady) {
    initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });
    transactionalReady = true;
  }

  const sent: SentMail[] = [];
  const deliver = (email: string, secret: string) => {
    if (failMail) return Promise.reject(new Error('smtp down'));
    sent.push({ email, secret });
    return Promise.resolve();
  };
  const mail = {
    sendRegistrationOtp: () => Promise.resolve(),
    sendRegistrationMagicLink: () => Promise.resolve(),
    sendLoginOtp: deliver,
    sendLoginMagicLink: (email: string, link: string) =>
      deliver(
        email,
        new URLSearchParams(new URL(link).hash.slice(1)).get('token')!,
      ),
  };

  const settings: Record<string, string> = {
    LOGIN_THROTTLE_LIMIT: '1000',
    REFRESH_THROTTLE_LIMIT: '1000',
    LOGIN_EMAIL_CONFIRMATION_ENABLED: 'false',
    AUTH_TRUSTED_ORIGIN: TRUSTED_ORIGIN,
    ...env,
  };
  const config = { get: (key: string) => settings[key] ?? process.env[key] };

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
  passwordHash ??= await app
    .get(PasswordService, { strict: false })
    .hash(PASSWORD);
  return { app, sent, config: settings };
}

async function createUser(app: TestApp, status = 'active') {
  const email = uniqueEmail();
  const rows: { id: string }[] = await app.db.query(
    'INSERT INTO users (email, password_hash, status) VALUES ($1, $2, $3) RETURNING id',
    [email, passwordHash, status],
  );
  return { id: rows[0].id, email };
}

async function cleanup(app: TestApp) {
  await app.db.query(
    `DELETE FROM users WHERE email LIKE '${PREFIX}-%${DOMAIN}'`,
  );
  await app.close();
}

const post = (
  app: TestApp,
  url: string,
  payload?: object,
  headers: Record<string, string> = {},
) => app.inject({ method: 'POST', url, payload, headers });

const login = (
  app: TestApp,
  email: string,
  password = PASSWORD,
  headers: Record<string, string> = {},
) => post(app, '/auth/login', { email, password }, headers);

const setCookies = (res: Res): string[] => {
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw : [raw]).filter(Boolean) as string[];
};
const cookieLine = (res: Res, name: string) =>
  setCookies(res).find((line) => line.startsWith(`${name}=`));
const cookieValue = (res: Res, name: string) =>
  cookieLine(res, name)!.split(';')[0].split('=')[1];
const claims = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

const asCookie = (name: string, value: string) => ({
  cookie: `${name}=${value}`,
});
const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

describe('Auth login (e2e)', () => {
  describe('direct login (confirmation disabled)', () => {
    let ctx: Ctx;
    beforeAll(async () => {
      ctx = await createApp();
    });
    afterAll(() => cleanup(ctx.app));

    it('answers 204 with both HttpOnly cookies and no body', async () => {
      const { email, id } = await createUser(ctx.app);

      const res = await login(ctx.app, email);

      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      expect(cookieLine(res, 'access_token')).toBe(
        `access_token=${cookieValue(res, 'access_token')}; Path=/; Max-Age=900; HttpOnly; Secure; SameSite=Strict`,
      );
      expect(cookieLine(res, 'refresh_token')).toBe(
        `refresh_token=${cookieValue(res, 'refresh_token')}; Path=/auth/refresh; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict`,
      );
      expect(setCookies(res).join()).not.toMatch(/domain/i);

      const access = claims(cookieValue(res, 'access_token'));
      const refresh = claims(cookieValue(res, 'refresh_token'));
      expect(access).toEqual({
        sub: id,
        iss: process.env.JWT_ISSUER,
        aud: process.env.JWT_AUDIENCE,
        iat: expect.any(Number),
        exp: expect.any(Number),
        token_use: 'access',
      });
      expect(access.exp - access.iat).toBe(900);
      expect(refresh).toMatchObject({ sub: id, token_use: 'refresh' });
      expect(refresh.exp - refresh.iat).toBe(2592000);
    });

    it('normalizes the email and keeps the password as typed', async () => {
      const { email } = await createUser(ctx.app);

      const ok = await login(ctx.app, `  ${email.toUpperCase()} `);
      const spaced = await login(ctx.app, email, ` ${PASSWORD}`);

      expect(ok.statusCode).toBe(204);
      expect(spaced.statusCode).toBe(401);
    });

    it('answers the identical 401 for unknown email, wrong password and pending user', async () => {
      const active = await createUser(ctx.app);
      const pending = await createUser(ctx.app, 'pending');

      const responses = [
        await login(ctx.app, uniqueEmail()),
        await login(ctx.app, active.email, 'Wrong-pass1'),
        await login(ctx.app, pending.email),
      ];

      for (const res of responses) {
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({
          statusCode: 401,
          code: 'invalid_credentials',
          message: 'Invalid credentials',
        });
        expect(res.headers['set-cookie']).toBeUndefined();
      }
    });

    it.each([
      ['an invalid email', { email: 'nope', password: PASSWORD }],
      ['a missing password', { email: 'a@b.co' }],
      ['an empty password', { email: 'a@b.co', password: '' }],
      ['an oversized password', { email: 'a@b.co', password: 'x'.repeat(500) }],
    ])('rejects %s with 400', async (_name, payload) => {
      const res = await post(ctx.app, '/auth/login', payload);

      expect(res.statusCode).toBe(400);
    });

    it('does not expose login through GET', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/auth/login' });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('refresh and logout', () => {
    let ctx: Ctx;
    beforeAll(async () => {
      ctx = await createApp();
    });
    afterAll(() => cleanup(ctx.app));

    async function signedIn() {
      const user = await createUser(ctx.app);
      const res = await login(ctx.app, user.email);
      return {
        ...user,
        access: cookieValue(res, 'access_token'),
        refresh: cookieValue(res, 'refresh_token'),
      };
    }

    it('rotates the pair from the refresh cookie without a body (204)', async () => {
      const user = await signedIn();
      await new Promise((r) => setTimeout(r, 1100));

      const res = await post(
        ctx.app,
        '/auth/refresh',
        undefined,
        asCookie('refresh_token', user.refresh),
      );

      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      expect(cookieValue(res, 'access_token')).not.toBe(user.access);
      expect(cookieValue(res, 'refresh_token')).not.toBe(user.refresh);
      expect(claims(cookieValue(res, 'access_token'))).toMatchObject({
        sub: user.id,
        token_use: 'access',
      });
      expect(cookieLine(res, 'refresh_token')).toContain('Path=/auth/refresh');
    });

    it.each([
      ['no cookie', {}],
      ['a garbage cookie', asCookie('refresh_token', 'garbage')],
    ])('answers 401 invalid_session with %s', async (_name, headers) => {
      const res = await post(ctx.app, '/auth/refresh', undefined, headers);

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: 'invalid_session' });
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('rejects an access token used as a refresh token', async () => {
      const user = await signedIn();

      const res = await post(
        ctx.app,
        '/auth/refresh',
        undefined,
        asCookie('refresh_token', user.access),
      );

      expect(res.statusCode).toBe(401);
    });

    it('reads the refresh token from the cookie only', async () => {
      const user = await signedIn();

      const inBody = await post(ctx.app, '/auth/refresh', {
        refresh_token: user.refresh,
      });
      const inHeader = await post(ctx.app, '/auth/refresh', undefined, {
        authorization: `Bearer ${user.refresh}`,
        'x-refresh-token': user.refresh,
      });

      expect(inBody.statusCode).toBe(401);
      expect(inHeader.statusCode).toBe(401);
    });

    it('refuses to refresh once the user is no longer active', async () => {
      const user = await signedIn();
      await ctx.app.db.query(
        "UPDATE users SET status = 'pending' WHERE id = $1",
        [user.id],
      );

      const res = await post(
        ctx.app,
        '/auth/refresh',
        undefined,
        asCookie('refresh_token', user.refresh),
      );

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: 'invalid_session' });
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('refuses to refresh for a deleted user', async () => {
      const user = await signedIn();
      await ctx.app.db.query('DELETE FROM users WHERE id = $1', [user.id]);

      const res = await post(
        ctx.app,
        '/auth/refresh',
        undefined,
        asCookie('refresh_token', user.refresh),
      );

      expect(res.statusCode).toBe(401);
    });

    it('answers 204 and clears both cookies on logout', async () => {
      const user = await signedIn();

      const res = await post(ctx.app, '/auth/logout', undefined, {
        cookie: `access_token=${user.access}; refresh_token=${user.refresh}`,
      });

      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      expect(cookieLine(res, 'access_token')).toBe(
        'access_token=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict',
      );
      expect(cookieLine(res, 'refresh_token')).toBe(
        'refresh_token=; Path=/auth/refresh; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict',
      );
    });

    it.each([
      ['no cookies', {}],
      ['invalid cookies', { cookie: 'access_token=bad; refresh_token=bad' }],
    ])('answers 204 and clears the cookies with %s', async (_name, headers) => {
      const res = await post(ctx.app, '/auth/logout', undefined, headers);

      expect(res.statusCode).toBe(204);
      expect(setCookies(res)).toHaveLength(2);
    });

    it('does not revoke a refresh token on the server', async () => {
      const user = await signedIn();
      await post(ctx.app, '/auth/logout');

      const res = await post(
        ctx.app,
        '/auth/refresh',
        undefined,
        asCookie('refresh_token', user.refresh),
      );

      expect(res.statusCode).toBe(204);
    });
  });

  describe('access check on a protected route', () => {
    let ctx: Ctx;
    beforeAll(async () => {
      ctx = await createApp();
    });
    afterAll(() => cleanup(ctx.app));

    const adminRoles = (headers: Record<string, string> = {}) =>
      ctx.app.inject({ method: 'GET', url: '/admin/rbac/roles', headers });

    it('authenticates a signed-in user (then RBAC denies: 403, not 401)', async () => {
      const { email } = await createUser(ctx.app);
      const res = await login(ctx.app, email);

      const roles = await adminRoles(
        asCookie('access_token', cookieValue(res, 'access_token')),
      );

      expect(roles.statusCode).toBe(403);
    });

    it('answers 401 invalid_session without a cookie or with a refresh token', async () => {
      const { email } = await createUser(ctx.app);
      const res = await login(ctx.app, email);

      const none = await adminRoles();
      const refresh = await adminRoles(
        asCookie('access_token', cookieValue(res, 'refresh_token')),
      );

      for (const r of [none, refresh]) {
        expect(r.statusCode).toBe(401);
        expect(r.json()).toEqual({
          statusCode: 401,
          code: 'invalid_session',
          message: 'Invalid session',
        });
      }
    });
  });

  describe('CSRF and origins', () => {
    let ctx: Ctx;
    beforeAll(async () => {
      ctx = await createApp();
    });
    afterAll(() => cleanup(ctx.app));

    it('rejects a trusted cross-origin POST without X-CSRF-Protection (403)', async () => {
      const { email } = await createUser(ctx.app);

      const res = await login(ctx.app, email, PASSWORD, {
        origin: TRUSTED_ORIGIN,
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'csrf_rejected' });
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('accepts the trusted origin with X-CSRF-Protection: 1', async () => {
      const { email } = await createUser(ctx.app);

      const res = await login(ctx.app, email, PASSWORD, {
        origin: TRUSTED_ORIGIN,
        'x-csrf-protection': '1',
      });

      expect(res.statusCode).toBe(204);
    });

    it.each([
      '/auth/login',
      '/auth/login/confirm',
      '/auth/login/resend',
      '/auth/refresh',
      '/auth/logout',
    ])(
      'rejects an untrusted origin on %s even with the header',
      async (url) => {
        const res = await post(
          ctx.app,
          url,
          {},
          {
            origin: 'https://evil.example',
            'x-csrf-protection': '1',
          },
        );

        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'csrf_rejected' });
      },
    );

    it('does not clear cookies for a rejected logout', async () => {
      const res = await post(ctx.app, '/auth/logout', undefined, {
        origin: 'https://evil.example',
      });

      expect(res.statusCode).toBe(403);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('accepts a same-origin POST without the custom header', async () => {
      const { email } = await createUser(ctx.app);

      const res = await login(ctx.app, email, PASSWORD, {
        origin: 'http://localhost:80',
      });

      expect(res.statusCode).toBe(204);
    });
  });

  describe('cross-site cookies', () => {
    it('uses SameSite=None; Secure when configured', async () => {
      const ctx = await createApp({ AUTH_COOKIE_CROSS_SITE: 'true' });
      const { email } = await createUser(ctx.app);

      const res = await login(ctx.app, email, PASSWORD, {
        origin: TRUSTED_ORIGIN,
        'x-csrf-protection': '1',
      });
      const out = await post(ctx.app, '/auth/logout', undefined, {
        origin: TRUSTED_ORIGIN,
        'x-csrf-protection': '1',
      });

      for (const line of [...setCookies(res), ...setCookies(out)]) {
        expect(line).toContain('SameSite=None');
        expect(line).toContain('Secure');
      }
      await cleanup(ctx.app);
    });
  });

  describe('rate limiting', () => {
    it('answers 429 once the login limit per IP is exceeded', async () => {
      const ctx = await createApp({
        LOGIN_THROTTLE_LIMIT: '2',
        LOGIN_THROTTLE_TTL: '60000',
      });
      const { email } = await createUser(ctx.app);

      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        statuses.push((await login(ctx.app, email)).statusCode);
      }

      expect(statuses).toEqual([204, 204, 429]);
      await cleanup(ctx.app);
    });

    it('blocks an email and IP pair after 5 failed checks, then recovers for others', async () => {
      const ctx = await createApp();
      const victim = await createUser(ctx.app);
      const other = await createUser(ctx.app);

      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        statuses.push(
          (await login(ctx.app, victim.email, 'Wrong-pass1')).statusCode,
        );
      }
      const blocked = await login(ctx.app, victim.email);
      const unaffected = await login(ctx.app, other.email);

      expect(statuses).toEqual([401, 401, 401, 401, 401]);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['set-cookie']).toBeUndefined();
      expect(unaffected.statusCode).toBe(204);
      await cleanup(ctx.app);
    });

    it('answers 429 once the refresh limit per IP is exceeded', async () => {
      const ctx = await createApp({
        REFRESH_THROTTLE_LIMIT: '2',
        REFRESH_THROTTLE_TTL: '60000',
      });
      const { email } = await createUser(ctx.app);
      const refresh = cookieValue(await login(ctx.app, email), 'refresh_token');

      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        statuses.push(
          (
            await post(
              ctx.app,
              '/auth/refresh',
              undefined,
              asCookie('refresh_token', refresh),
            )
          ).statusCode,
        );
      }

      expect(statuses).toEqual([204, 204, 429]);
      await cleanup(ctx.app);
    });
  });

  describe('email confirmation (OTP)', () => {
    let ctx: Ctx;
    beforeAll(async () => {
      ctx = await createApp({
        LOGIN_EMAIL_CONFIRMATION_ENABLED: 'true',
        LOGIN_EMAIL_CONFIRMATION_METHOD: 'otp',
      });
    });
    afterAll(() => cleanup(ctx.app));

    const lastCode = (email: string) =>
      ctx.sent.filter((m) => m.email === email).at(-1)!.secret;
    const confirm = (payload: object) =>
      post(ctx.app, '/auth/login/confirm', payload);
    const shiftSentAt = (attemptId: string, seconds: number) =>
      ctx.app.db.query(
        `UPDATE login_attempts SET last_sent_at = now() - make_interval(secs => $2) WHERE id = $1`,
        [attemptId, seconds],
      );

    async function startLogin() {
      const user = await createUser(ctx.app);
      const res = await login(ctx.app, user.email);
      return { ...user, res, body: res.json() };
    }

    it('answers 202 without cookies or the code, then confirms with 204 and cookies', async () => {
      const { email, res, body } = await startLogin();

      expect(res.statusCode).toBe(202);
      expect(body).toEqual({
        confirmationRequired: true,
        method: 'otp',
        attemptId: expect.any(String),
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.body).not.toContain(lastCode(email));
      expect(lastCode(email)).toMatch(/^\d{6}$/);

      const ok = await confirm({
        attemptId: body.attemptId,
        code: lastCode(email),
      });
      expect(ok.statusCode).toBe(204);
      expect(ok.body).toBe('');
      expect(cookieLine(ok, 'access_token')).toContain('HttpOnly');
      expect(cookieLine(ok, 'refresh_token')).toContain('Path=/auth/refresh');

      const again = await confirm({
        attemptId: body.attemptId,
        code: lastCode(email),
      });
      expect(again.statusCode).toBe(400);
      expect(again.headers['set-cookie']).toBeUndefined();
    });

    it('stores only an HMAC of the code', async () => {
      const { email, body } = await startLogin();

      const [row] = await ctx.app.db.query(
        'SELECT secret_hash FROM login_attempts WHERE id = $1',
        [body.attemptId],
      );

      expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.secret_hash).not.toContain(lastCode(email));
    });

    it('sends no email and starts no attempt for wrong credentials', async () => {
      const { id, email } = await createUser(ctx.app);

      const res = await login(ctx.app, email, 'Wrong-pass1');
      const [{ count }] = await ctx.app.db.query(
        'SELECT count(*)::int AS count FROM login_attempts WHERE user_id = $1',
        [id],
      );

      expect(res.statusCode).toBe(401);
      expect(ctx.sent.some((m) => m.email === email)).toBe(false);
      expect(count).toBe(0);
    });

    it('allows the correct fifth code after four wrong ones', async () => {
      const { email, body } = await startLogin();
      for (let i = 0; i < 4; i++) {
        await confirm({
          attemptId: body.attemptId,
          code: wrong(lastCode(email)),
        });
      }

      const res = await confirm({
        attemptId: body.attemptId,
        code: lastCode(email),
      });

      expect(res.statusCode).toBe(204);
    });

    it('answers 400 on the fifth wrong code, then 429 even for the correct one', async () => {
      const { email, body } = await startLogin();
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await confirm({
          attemptId: body.attemptId,
          code: wrong(lastCode(email)),
        });
        statuses.push(res.statusCode);
      }
      expect(statuses).toEqual([400, 400, 400, 400, 400]);

      const res = await confirm({
        attemptId: body.attemptId,
        code: lastCode(email),
      });
      const [row] = await ctx.app.db.query(
        'SELECT consumed_reason FROM login_attempts WHERE id = $1',
        [body.attemptId],
      );

      expect(res.statusCode).toBe(429);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(row.consumed_reason).toBe('attempts_exhausted');
    });

    it('answers wrong, unknown and malformed confirmations with the same 400', async () => {
      const { email, body } = await startLogin();

      const results = [
        await confirm({
          attemptId: body.attemptId,
          code: wrong(lastCode(email)),
        }),
        await confirm({
          attemptId: '0b8b6f4e-6a53-4b0c-9a51-0d3d7a4c9f10',
          code: '123456',
        }),
      ];

      for (const res of results) expect(res.statusCode).toBe(400);
      expect(results[1].json().message).toBe(results[0].json().message);

      for (const bad of [
        {},
        { code: '123456' },
        { attemptId: body.attemptId, code: '12345' },
        { attemptId: 'not-a-uuid', code: '123456' },
      ]) {
        expect((await confirm(bad)).statusCode).toBe(400);
      }
    });

    it('rejects an expired attempt without counting a failure', async () => {
      const { email, body } = await startLogin();
      await shiftSentAt(body.attemptId, 601);

      const res = await confirm({
        attemptId: body.attemptId,
        code: wrong(lastCode(email)),
      });
      const [row] = await ctx.app.db.query(
        'SELECT attempts FROM login_attempts WHERE id = $1',
        [body.attemptId],
      );

      expect(res.statusCode).toBe(400);
      expect(row.attempts).toBe(0);
    });

    it('refuses with the neutral 401 when the user stopped being active', async () => {
      const { id, email, body } = await startLogin();
      await ctx.app.db.query(
        "UPDATE users SET status = 'pending' WHERE id = $1",
        [id],
      );

      const res = await confirm({
        attemptId: body.attemptId,
        code: lastCode(email),
      });
      const retry = await confirm({
        attemptId: body.attemptId,
        code: lastCode(email),
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: 'invalid_credentials' });
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(retry.statusCode).toBe(400);
    });

    it('limits a new email to once per 60 seconds, then replaces the old code', async () => {
      const { email, body } = await startLogin();
      const first = lastCode(email);

      const tooSoon = await login(ctx.app, email);
      expect(tooSoon.statusCode).toBe(429);
      expect(tooSoon.json().retryAfterSeconds).toBeGreaterThan(50);
      expect(ctx.sent.filter((m) => m.email === email)).toHaveLength(1);

      await shiftSentAt(body.attemptId, 61);
      const second = await login(ctx.app, email);
      expect(second.statusCode).toBe(202);
      expect(second.json().attemptId).not.toBe(body.attemptId);

      if (lastCode(email) !== first) {
        const stale = await confirm({ attemptId: body.attemptId, code: first });
        expect(stale.statusCode).toBe(400);
      }
      const ok = await confirm({
        attemptId: second.json().attemptId,
        code: lastCode(email),
      });
      expect(ok.statusCode).toBe(204);
    });

    it('resends once per 60 seconds, keeping the method, and invalidates the old code', async () => {
      const { email, body } = await startLogin();
      const first = lastCode(email);
      const resend = (attemptId: string) =>
        post(ctx.app, '/auth/login/resend', { attemptId });

      const tooSoon = await resend(body.attemptId);
      expect(tooSoon.statusCode).toBe(429);
      expect(tooSoon.json().retryAfterSeconds).toBeGreaterThan(50);

      await shiftSentAt(body.attemptId, 61);
      const ok = await resend(body.attemptId);
      expect(ok.statusCode).toBe(202);
      expect(ok.json()).toEqual({
        method: 'otp',
        attemptId: body.attemptId,
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });
      expect(ok.body).not.toContain(lastCode(email));

      if (lastCode(email) !== first) {
        const stale = await confirm({ attemptId: body.attemptId, code: first });
        expect(stale.statusCode).toBe(400);
      }
      const confirmed = await confirm({
        attemptId: body.attemptId,
        code: lastCode(email),
      });
      expect(confirmed.statusCode).toBe(204);
    });

    it('answers resend for an unknown or finished attempt with 400', async () => {
      const { email, body } = await startLogin();
      await confirm({ attemptId: body.attemptId, code: lastCode(email) });

      const finished = await post(ctx.app, '/auth/login/resend', {
        attemptId: body.attemptId,
      });
      const unknown = await post(ctx.app, '/auth/login/resend', {
        attemptId: '0b8b6f4e-6a53-4b0c-9a51-0d3d7a4c9f10',
      });

      expect(finished.statusCode).toBe(400);
      expect(unknown.statusCode).toBe(400);
    });

    it('answers resend for an exhausted attempt with 429', async () => {
      const { email, body } = await startLogin();
      for (let i = 0; i < 5; i++) {
        await confirm({
          attemptId: body.attemptId,
          code: wrong(lastCode(email)),
        });
      }

      const res = await post(ctx.app, '/auth/login/resend', {
        attemptId: body.attemptId,
      });

      expect(res.statusCode).toBe(429);
    });

    it('lets exactly one of two concurrent logins create an attempt', async () => {
      const { id, email } = await createUser(ctx.app);

      const results = await Promise.all([
        login(ctx.app, email),
        login(ctx.app, email),
      ]);
      const [{ open }] = await ctx.app.db.query(
        'SELECT count(*)::int AS open FROM login_attempts WHERE user_id = $1 AND consumed_at IS NULL',
        [id],
      );

      expect(results.map((r) => r.statusCode).sort()).toEqual([202, 429]);
      expect(open).toBe(1);
    });

    it('lets a refresh token created by a confirmed login be rotated', async () => {
      const { email, body } = await startLogin();
      const ok = await confirm({
        attemptId: body.attemptId,
        code: lastCode(email),
      });

      const res = await post(
        ctx.app,
        '/auth/refresh',
        undefined,
        asCookie('refresh_token', cookieValue(ok, 'refresh_token')),
      );

      expect(res.statusCode).toBe(204);
    });
  });

  describe('email confirmation (magic link)', () => {
    let ctx: Ctx;
    beforeAll(async () => {
      ctx = await createApp({
        LOGIN_EMAIL_CONFIRMATION_ENABLED: 'true',
        LOGIN_EMAIL_CONFIRMATION_METHOD: 'magic_link',
      });
    });
    afterAll(() => cleanup(ctx.app));

    it('signs in only by POST with the fragment token, once', async () => {
      const { email } = await createUser(ctx.app);
      const res = await login(ctx.app, email);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ method: 'magic_link' });

      const token = ctx.sent.find((m) => m.email === email)!.secret;
      expect(res.body).not.toContain(token);
      expect(token.split('.')[0]).toBe(res.json().attemptId);

      const get = await ctx.app.inject({
        method: 'GET',
        url: `/auth/login/confirm?token=${token}`,
      });
      expect(get.statusCode).toBe(404);

      const ok = await post(ctx.app, '/auth/login/confirm', { token });
      expect(ok.statusCode).toBe(204);
      expect(cookieLine(ok, 'access_token')).toBeDefined();

      const reuse = await post(ctx.app, '/auth/login/confirm', { token });
      expect(reuse.statusCode).toBe(400);
    });

    it('answers 400 for a wrong secret without limiting the real link', async () => {
      const { email } = await createUser(ctx.app);
      const res = await login(ctx.app, email);
      const attemptId = res.json().attemptId;
      const token = ctx.sent.find((m) => m.email === email)!.secret;

      for (let i = 0; i < 6; i++) {
        const bad = await post(ctx.app, '/auth/login/confirm', {
          token: `${attemptId}.${'A'.repeat(43)}`,
        });
        expect(bad.statusCode).toBe(400);
      }

      const ok = await post(ctx.app, '/auth/login/confirm', { token });
      expect(ok.statusCode).toBe(204);
    });

    it('resends a new link of the same method', async () => {
      const { email } = await createUser(ctx.app);
      const res = await login(ctx.app, email);
      const attemptId = res.json().attemptId;
      const oldToken = ctx.sent.find((m) => m.email === email)!.secret;
      await ctx.app.db.query(
        `UPDATE login_attempts SET last_sent_at = now() - interval '61 seconds' WHERE id = $1`,
        [attemptId],
      );

      const resend = await post(ctx.app, '/auth/login/resend', { attemptId });
      const newToken = ctx.sent.filter((m) => m.email === email).at(-1)!.secret;

      expect(resend.statusCode).toBe(202);
      expect(resend.json().method).toBe('magic_link');
      expect(newToken).not.toBe(oldToken);
      expect(
        (await post(ctx.app, '/auth/login/confirm', { token: oldToken }))
          .statusCode,
      ).toBe(400);
      expect(
        (await post(ctx.app, '/auth/login/confirm', { token: newToken }))
          .statusCode,
      ).toBe(204);
    });
  });

  describe('delivery failure', () => {
    it('keeps the attempt and answers 503 with retry data but no secret', async () => {
      const ctx = await createApp(
        {
          LOGIN_EMAIL_CONFIRMATION_ENABLED: 'true',
          LOGIN_EMAIL_CONFIRMATION_METHOD: 'otp',
        },
        true,
      );
      const { id, email } = await createUser(ctx.app);

      const res = await login(ctx.app, email);
      const [row] = await ctx.app.db.query(
        'SELECT id, consumed_at, secret_hash FROM login_attempts WHERE user_id = $1',
        [id],
      );

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({
        confirmationRequired: true,
        method: 'otp',
        attemptId: row.id,
        retryAfterSeconds: expect.any(Number),
      });
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(row.consumed_at).toBeNull();

      // A retry inside the pause cannot bypass the send limit.
      const again = await login(ctx.app, email);
      expect(again.statusCode).toBe(429);
      await cleanup(ctx.app);
    });
  });
});
