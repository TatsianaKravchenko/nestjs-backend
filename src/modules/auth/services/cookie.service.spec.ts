/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ConfigService } from '@/core/config/config.service';

import { CookieService } from './cookie.service';

function build(crossSite = 'false') {
  const config = { get: () => crossSite };
  const service = new CookieService(config as unknown as ConfigService);
  const header = jest.fn();
  const reply = { header } as unknown as FastifyReply;
  const cookies = () => header.mock.calls[0][1] as string[];
  return { service, reply, header, cookies };
}

describe('CookieService', () => {
  it('sets both cookies with the documented attributes and no Domain', () => {
    const { service, reply, header, cookies } = build();

    service.issue(reply, { access: 'acc.jwt.value', refresh: 'ref.jwt.value' });

    expect(header).toHaveBeenCalledWith('set-cookie', expect.any(Array));
    expect(cookies()).toEqual([
      'access_token=acc.jwt.value; Path=/; Max-Age=900; HttpOnly; Secure; SameSite=Strict',
      'refresh_token=ref.jwt.value; Path=/auth/refresh; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict',
    ]);
    expect(cookies().join()).not.toMatch(/domain/i);
  });

  it('uses SameSite=None; Secure for a cross-site frontend', () => {
    const { service, reply, cookies } = build('true');

    service.issue(reply, { access: 'a', refresh: 'r' });

    for (const cookie of cookies()) {
      expect(cookie).toContain('SameSite=None');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('HttpOnly');
    }
  });

  it('clears both cookies with the same Path and SameSite', () => {
    const { service, reply, cookies } = build();

    service.clear(reply);

    expect(cookies()).toEqual([
      'access_token=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict',
      'refresh_token=; Path=/auth/refresh; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict',
    ]);
  });

  it('keeps SameSite=None when clearing for a cross-site frontend', () => {
    const { service, reply, cookies } = build('true');

    service.clear(reply);

    for (const cookie of cookies()) {
      expect(cookie).toContain('SameSite=None');
    }
  });

  describe('read', () => {
    const request = (cookie?: string) =>
      ({ headers: { cookie } }) as unknown as FastifyRequest;

    it('finds a cookie by exact name', () => {
      const { service } = build();

      expect(
        service.read(
          request('a=1; access_token=tok; x_access_token=no'),
          'access_token',
        ),
      ).toBe('tok');
    });

    it('returns undefined without a header, a match or a value', () => {
      const { service } = build();

      expect(service.read(request(undefined), 'access_token')).toBeUndefined();
      expect(service.read(request('other=1'), 'access_token')).toBeUndefined();
      expect(
        service.read(request('access_token='), 'access_token'),
      ).toBeUndefined();
    });
  });
});
