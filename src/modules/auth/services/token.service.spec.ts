/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { ConfigService } from '@/core/config/config.service';

import { TokenFailureReason } from '../errors/auth.errors';
import { AuthAuditService } from './auth-audit.service';
import { InvalidTokenError, TokenService } from './token.service';

const USER_ID = '0b8b6f4e-6a53-4b0c-9a51-0d3d7a4c9f10';
const values: Record<string, string> = {
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'r'.repeat(40),
  JWT_ISSUER: 'test-issuer',
  JWT_AUDIENCE: 'test-audience',
};

function build() {
  const jwt = new JwtService();
  const audit = { error: jest.fn() };
  const config = { get: (key: string) => values[key] };
  const service = new TokenService(
    jwt,
    config as unknown as ConfigService,
    audit as unknown as AuthAuditService,
  );
  return { service, jwt, audit };
}

/** A token signed outside the service, to forge the cases it must reject. */
function forge(
  jwt: JwtService,
  claims: Record<string, unknown> = { token_use: 'access' },
  options: Record<string, unknown> = {},
): string {
  return jwt.sign(claims, {
    algorithm: 'HS256',
    secret: values.JWT_ACCESS_SECRET,
    subject: USER_ID,
    issuer: values.JWT_ISSUER,
    audience: values.JWT_AUDIENCE,
    expiresIn: 900,
    ...options,
  });
}

const lifetime = (payload: unknown): number => {
  const { exp, iat } = payload as { exp: number; iat: number };
  return exp - iat;
};

async function reasonOf(
  promise: Promise<unknown>,
): Promise<TokenFailureReason> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(InvalidTokenError);
  return (error as InvalidTokenError).reason;
}

describe('TokenService', () => {
  describe('issuePair', () => {
    it('signs HS256 tokens with the documented claims and lifetimes', async () => {
      const { service, jwt } = build();

      const pair = await service.issuePair(USER_ID);

      const access = jwt.decode(pair.access, { complete: true });
      const refresh = jwt.decode(pair.refresh, { complete: true });
      expect(access.header.alg).toBe('HS256');
      expect(refresh.header.alg).toBe('HS256');
      expect(access.payload).toEqual({
        sub: USER_ID,
        iss: 'test-issuer',
        aud: 'test-audience',
        iat: expect.any(Number),
        exp: expect.any(Number),
        token_use: 'access',
      });
      expect(refresh.payload).toMatchObject({
        sub: USER_ID,
        token_use: 'refresh',
      });
      expect(lifetime(access.payload)).toBe(15 * 60);
      expect(lifetime(refresh.payload)).toBe(30 * 24 * 3600);
    });

    it('never puts roles, email or a jti in the payload', async () => {
      const { service, jwt } = build();

      const { access } = await service.issuePair(USER_ID);

      expect(Object.keys(jwt.decode(access)).sort()).toEqual(
        ['aud', 'exp', 'iat', 'iss', 'sub', 'token_use'].sort(),
      );
    });

    it('uses a different key for each kind of token', async () => {
      const { service, jwt } = build();

      const { access, refresh } = await service.issuePair(USER_ID);

      expect(() =>
        jwt.verify(access, { secret: values.JWT_REFRESH_SECRET }),
      ).toThrow();
      expect(() =>
        jwt.verify(refresh, { secret: values.JWT_ACCESS_SECRET }),
      ).toThrow();
    });

    it('answers 503 and logs when signing fails', async () => {
      const { service, jwt, audit } = build();
      jest.spyOn(jwt, 'signAsync').mockRejectedValue(new Error('no key'));

      await expect(service.issuePair(USER_ID)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(audit.error).toHaveBeenCalledWith('token.signing_unavailable', {
        userId: USER_ID,
      });
    });
  });

  describe('verify', () => {
    it('returns the user id of a valid access and refresh token', async () => {
      const { service } = build();
      const { access, refresh } = await service.issuePair(USER_ID);

      await expect(service.verifyAccess(access)).resolves.toBe(USER_ID);
      await expect(service.verifyRefresh(refresh)).resolves.toBe(USER_ID);
    });

    it('rejects a missing token', async () => {
      const { service } = build();

      expect(await reasonOf(service.verifyAccess(undefined))).toBe('missing');
      expect(await reasonOf(service.verifyRefresh(''))).toBe('missing');
    });

    it('rejects garbage as malformed', async () => {
      const { service } = build();

      expect(await reasonOf(service.verifyAccess('not-a-jwt'))).toBe(
        'malformed',
      );
    });

    it('rejects a wrong signature', async () => {
      const { service, jwt } = build();
      const token = forge(
        jwt,
        { token_use: 'access' },
        { secret: 'x'.repeat(40) },
      );

      expect(await reasonOf(service.verifyAccess(token))).toBe('signature');
    });

    it('rejects an access token presented as a refresh token and vice versa', async () => {
      const { service } = build();
      const { access, refresh } = await service.issuePair(USER_ID);

      // Different keys, so the signature already fails; token_use is the second line of defence.
      expect(await reasonOf(service.verifyRefresh(access))).toBe('signature');
      expect(await reasonOf(service.verifyAccess(refresh))).toBe('signature');
    });

    it('rejects the wrong token_use even with a valid signature', async () => {
      const { service, jwt } = build();
      const token = forge(jwt, { token_use: 'refresh' });

      expect(await reasonOf(service.verifyAccess(token))).toBe('token_use');
    });

    it('rejects a token without token_use', async () => {
      const { service, jwt } = build();

      expect(await reasonOf(service.verifyAccess(forge(jwt, {})))).toBe(
        'token_use',
      );
    });

    it.each([
      ['issuer', { issuer: 'other' }],
      ['audience', { audience: 'other' }],
    ])('rejects a wrong %s', async (_name, options) => {
      const { service, jwt } = build();
      const token = forge(jwt, { token_use: 'access' }, options);

      expect(await reasonOf(service.verifyAccess(token))).toBe('claims');
    });

    it('rejects a token that expired beyond the 30 second tolerance', async () => {
      const { service, jwt } = build();
      const token = forge(jwt, { token_use: 'access' }, { expiresIn: -120 });

      expect(await reasonOf(service.verifyAccess(token))).toBe('expired');
    });

    it('accepts a token that expired within the 30 second tolerance', async () => {
      const { service, jwt } = build();
      const token = forge(jwt, { token_use: 'access' }, { expiresIn: -10 });

      await expect(service.verifyAccess(token)).resolves.toBe(USER_ID);
    });

    it('rejects an empty or non-uuid subject', async () => {
      const { service, jwt } = build();

      for (const subject of ['not-a-uuid', ' ']) {
        const token = forge(jwt, { token_use: 'access' }, { subject });
        expect(await reasonOf(service.verifyAccess(token))).toBe('claims');
      }
    });

    it('rejects algorithms other than HS256', async () => {
      const { service, jwt } = build();
      const hs512 = forge(jwt, { token_use: 'access' }, { algorithm: 'HS512' });
      const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(
        JSON.stringify({ sub: USER_ID, token_use: 'access' }),
      ).toString('base64url')}.`;

      for (const token of [hs512, none]) {
        const reason: TokenFailureReason = await reasonOf(
          service.verifyAccess(token),
        );
        expect(['malformed', 'signature']).toContain(reason);
      }
    });
  });
});
