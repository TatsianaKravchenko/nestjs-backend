/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
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
import { MailService } from '../src/modules/auth/mail.service';

interface SentMail {
  email: string;
  secret: string;
}

const PASSWORD = 'Passw0rd-e2e';
const DOMAIN = '@example.test';
let counter = 0;
const uniqueEmail = () => `e2e-${Date.now()}-${counter++}${DOMAIN}`;

let transactionalReady = false;

type TestApp = NestFastifyApplication & { db: DataSource };

/** Per-app settings are layered over the real environment through a ConfigService override. */
async function createApp(env: Record<string, string>, failMail = false) {
  if (!transactionalReady) {
    initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });
    transactionalReady = true;
  }

  const sent: SentMail[] = [];
  const mail = {
    sendRegistrationOtp: (email: string, secret: string) => {
      if (failMail) return Promise.reject(new Error('smtp down'));
      sent.push({ email, secret });
      return Promise.resolve();
    },
    sendRegistrationMagicLink: (email: string, link: string) => {
      if (failMail) return Promise.reject(new Error('smtp down'));
      sent.push({ email, secret: new URL(link).searchParams.get('token')! });
      return Promise.resolve();
    },
  };

  const config = { get: (key: string) => env[key] ?? process.env[key] };

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
  return { app, sent };
}

const post = (app: TestApp, url: string, payload: object) =>
  app.inject({ method: 'POST', url, payload });

describe('Auth registration (e2e)', () => {
  const baseEnv = {
    REGISTRATION_THROTTLE_LIMIT: '1000',
    REGISTRATION_THROTTLE_TTL: '60000',
  };

  async function cleanup(app: TestApp) {
    await app.db.query(`DELETE FROM users WHERE email LIKE 'e2e-%${DOMAIN}'`);
    await app.close();
  }

  describe('confirmation disabled', () => {
    let ctx: Awaited<ReturnType<typeof createApp>>;

    beforeAll(async () => {
      ctx = await createApp({
        ...baseEnv,
        REGISTRATION_CONFIRMATION_ENABLED: 'false',
      });
    });
    afterAll(() => cleanup(ctx.app));

    it('registers an active user (201) and normalizes the email', async () => {
      const email = uniqueEmail();
      const res = await post(ctx.app, '/auth/register', {
        email: `  ${email.toUpperCase()} `,
        password: PASSWORD,
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        id: expect.any(String),
        email,
        status: 'active',
      });
      expect(res.headers['set-cookie']).toBeUndefined();

      const [row] = await ctx.app.db.query(
        'SELECT password_hash FROM users WHERE email = $1',
        [email],
      );
      expect(row.password_hash).toMatch(/^\$argon2id\$/);
      expect(row.password_hash).not.toContain(PASSWORD);
    });

    it('rejects a duplicate email in any casing (409)', async () => {
      const email = uniqueEmail();
      await post(ctx.app, '/auth/register', { email, password: PASSWORD });

      const res = await post(ctx.app, '/auth/register', {
        email: email.toUpperCase(),
        password: PASSWORD,
      });
      expect(res.statusCode).toBe(409);
    });

    it('treats plus-addressing as a different email', async () => {
      const email = uniqueEmail();
      await post(ctx.app, '/auth/register', { email, password: PASSWORD });

      const res = await post(ctx.app, '/auth/register', {
        email: email.replace('@', '+tag@'),
        password: PASSWORD,
      });
      expect(res.statusCode).toBe(201);
    });

    it('lets exactly one of two concurrent identical registrations win', async () => {
      const email = uniqueEmail();
      const results = await Promise.all([
        post(ctx.app, '/auth/register', { email, password: PASSWORD }),
        post(ctx.app, '/auth/register', { email, password: PASSWORD }),
      ]);

      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    });

    it.each([
      ['invalid email', { email: 'nope', password: PASSWORD }],
      ['short password', { email: uniqueEmail(), password: 'a1' }],
      ['no digit', { email: uniqueEmail(), password: 'abcdefghij' }],
      ['no letter', { email: uniqueEmail(), password: '1234567890' }],
      ['too long', { email: uniqueEmail(), password: `a1${'x'.repeat(500)}` }],
    ])('rejects %s (400)', async (_name, payload) => {
      const res = await post(ctx.app, '/auth/register', payload);
      expect(res.statusCode).toBe(400);
    });
  });

  describe('confirmation enabled (OTP)', () => {
    let ctx: Awaited<ReturnType<typeof createApp>>;

    beforeAll(async () => {
      ctx = await createApp({
        ...baseEnv,
        REGISTRATION_CONFIRMATION_ENABLED: 'true',
        REGISTRATION_CONFIRMATION_METHOD: 'otp',
      });
    });
    afterAll(() => cleanup(ctx.app));

    const registerPending = async () => {
      const email = uniqueEmail();
      const res = await post(ctx.app, '/auth/register', {
        email,
        password: PASSWORD,
      });
      return { email, res, body: res.json() };
    };
    const lastCode = (email: string) =>
      ctx.sent.filter((m) => m.email === email).at(-1)!.secret;
    const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

    it('answers 202 without leaking the code, then confirms (200)', async () => {
      const { email, res, body } = await registerPending();

      expect(res.statusCode).toBe(202);
      expect(body).toEqual({
        confirmationRequired: true,
        method: 'otp',
        attemptId: expect.any(String),
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });
      expect(res.body).not.toContain(lastCode(email));

      const confirm = await post(ctx.app, '/auth/register/confirm', {
        attemptId: body.attemptId,
        code: lastCode(email),
      });
      expect(confirm.statusCode).toBe(200);
      expect(confirm.json()).toEqual({
        id: expect.any(String),
        email,
        status: 'active',
      });

      const again = await post(ctx.app, '/auth/register/confirm', {
        attemptId: body.attemptId,
        code: lastCode(email),
      });
      expect(again.statusCode).toBe(400);
    });

    it('rejects a duplicate while still pending (409)', async () => {
      const { email } = await registerPending();
      const res = await post(ctx.app, '/auth/register', {
        email,
        password: PASSWORD,
      });
      expect(res.statusCode).toBe(409);
    });

    it('rejects wrong and unknown attempts with the same 400', async () => {
      const { email, body } = await registerPending();

      const wrongRes = await post(ctx.app, '/auth/register/confirm', {
        attemptId: body.attemptId,
        code: wrong(lastCode(email)),
      });
      const unknown = await post(ctx.app, '/auth/register/confirm', {
        attemptId: '0b8b6f4e-6a53-4b0c-9a51-0d3d7a4c9f10',
        code: '123456',
      });

      expect(wrongRes.statusCode).toBe(400);
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().message).toBe(wrongRes.json().message);
    });

    it('allows a correct 5th attempt after four wrong codes', async () => {
      const { email, body } = await registerPending();
      for (let i = 0; i < 4; i++) {
        await post(ctx.app, '/auth/register/confirm', {
          attemptId: body.attemptId,
          code: wrong(lastCode(email)),
        });
      }

      const res = await post(ctx.app, '/auth/register/confirm', {
        attemptId: body.attemptId,
        code: lastCode(email),
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns 429 on the 5th wrong code and rejects the correct one afterwards', async () => {
      const { email, body } = await registerPending();
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await post(ctx.app, '/auth/register/confirm', {
          attemptId: body.attemptId,
          code: wrong(lastCode(email)),
        });
        statuses.push(res.statusCode);
      }
      expect(statuses).toEqual([400, 400, 400, 400, 429]);

      const res = await post(ctx.app, '/auth/register/confirm', {
        attemptId: body.attemptId,
        code: lastCode(email),
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an expired attempt without incrementing failures', async () => {
      const { email, body } = await registerPending();
      const db = ctx.app.db;
      await db.query(
        `UPDATE registration_attempts SET expires_at = now() - interval '1 second' WHERE id = $1`,
        [body.attemptId],
      );

      const res = await post(ctx.app, '/auth/register/confirm', {
        attemptId: body.attemptId,
        code: wrong(lastCode(email)),
      });
      const [row] = await db.query(
        'SELECT failed_attempts FROM registration_attempts WHERE id = $1',
        [body.attemptId],
      );

      expect(res.statusCode).toBe(400);
      expect(row.failed_attempts).toBe(0);
    });

    it('stores only a hash of the code', async () => {
      const { email, body } = await registerPending();
      const [row] = await ctx.app.db.query(
        'SELECT secret_hash FROM registration_attempts WHERE id = $1',
        [body.attemptId],
      );

      expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.secret_hash).not.toContain(lastCode(email));
    });

    it('limits resend to once per 60s (429), then allows it', async () => {
      const { email, body } = await registerPending();
      const first = lastCode(email);

      const tooSoon = await post(ctx.app, '/auth/register/resend', { email });
      expect(tooSoon.statusCode).toBe(429);

      await ctx.app.db.query(
        `UPDATE registration_attempts SET last_sent_at = now() - interval '61 seconds' WHERE id = $1`,
        [body.attemptId],
      );
      const ok = await post(ctx.app, '/auth/register/resend', { email });
      expect(ok.statusCode).toBe(202);
      expect(ok.json()).toMatchObject({
        attemptId: body.attemptId,
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });

      const fresh = lastCode(email);
      const confirm = await post(ctx.app, '/auth/register/confirm', {
        attemptId: body.attemptId,
        code: fresh,
      });
      expect(confirm.statusCode).toBe(200);
      expect(typeof first).toBe('string');
    });

    it('rejects resend for unknown emails (400)', async () => {
      const res = await post(ctx.app, '/auth/register/resend', {
        email: uniqueEmail(),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('confirmation enabled (magic link)', () => {
    let ctx: Awaited<ReturnType<typeof createApp>>;

    beforeAll(async () => {
      ctx = await createApp({
        ...baseEnv,
        REGISTRATION_CONFIRMATION_ENABLED: 'true',
        REGISTRATION_CONFIRMATION_METHOD: 'magic_link',
      });
    });
    afterAll(() => cleanup(ctx.app));

    it('activates only by POST with the token, once', async () => {
      const email = uniqueEmail();
      const reg = await post(ctx.app, '/auth/register', {
        email,
        password: PASSWORD,
      });
      expect(reg.statusCode).toBe(202);
      expect(reg.json().method).toBe('magic_link');

      const token = ctx.sent.find((m) => m.email === email)!.secret;
      expect(reg.body).not.toContain(token);

      const get = await ctx.app.inject({
        method: 'GET',
        url: `/auth/register/confirm?token=${token}`,
      });
      expect(get.statusCode).toBe(404);

      const ok = await post(ctx.app, '/auth/register/confirm', { token });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ email, status: 'active' });

      const reuse = await post(ctx.app, '/auth/register/confirm', { token });
      expect(reuse.statusCode).toBe(400);
    });
  });

  describe('delivery failure', () => {
    it('answers 503, keeps the pending user and then reports a duplicate', async () => {
      const ctx = await createApp(
        {
          ...baseEnv,
          REGISTRATION_CONFIRMATION_ENABLED: 'true',
          REGISTRATION_CONFIRMATION_METHOD: 'otp',
        },
        true,
      );
      const email = uniqueEmail();

      const first = await post(ctx.app, '/auth/register', {
        email,
        password: PASSWORD,
      });
      const second = await post(ctx.app, '/auth/register', {
        email,
        password: PASSWORD,
      });
      const [row] = await ctx.app.db.query(
        `SELECT u.status, count(a.id)::int AS attempts FROM users u LEFT JOIN registration_attempts a ON a.user_id = u.id WHERE u.email = $1 GROUP BY u.status`,
        [email],
      );

      expect(first.statusCode).toBe(503);
      expect(second.statusCode).toBe(409);
      expect(row).toEqual({ status: 'pending', attempts: 1 });
      await cleanup(ctx.app);
    });
  });

  describe('rate limiting', () => {
    it('returns 429 once the configured limit is exceeded', async () => {
      const ctx = await createApp({
        REGISTRATION_THROTTLE_LIMIT: '2',
        REGISTRATION_THROTTLE_TTL: '60000',
        REGISTRATION_CONFIRMATION_ENABLED: 'false',
      });

      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await post(ctx.app, '/auth/register', {
          email: uniqueEmail(),
          password: PASSWORD,
        });
        statuses.push(res.statusCode);
      }

      expect(statuses).toEqual([201, 201, 429]);
      await cleanup(ctx.app);
    });
  });
});
