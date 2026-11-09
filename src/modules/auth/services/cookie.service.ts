import { Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ConfigService } from '@/core/config/config.service';

import {
  ACCESS_COOKIE,
  ACCESS_COOKIE_PATH,
  ACCESS_TTL_SECONDS,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_TTL_SECONDS,
} from '../constants/auth.constants';
import type { TokenPair } from './token.service';

/**
 * Auth cookies: host-only (no Domain), HttpOnly, Secure. SameSite is Strict
 * unless the trusted frontend is cross-site, then None. Cookies are written
 * and read here directly so they never depend on a Fastify plugin.
 */
@Injectable()
export class CookieService {
  constructor(private readonly config: ConfigService) {}

  //login, confirm, refresh
  issue(reply: FastifyReply, tokens: TokenPair): void {
    void reply.header('set-cookie', [
      this.serialize(
        ACCESS_COOKIE,
        tokens.access,
        ACCESS_COOKIE_PATH,
        ACCESS_TTL_SECONDS,
      ),
      this.serialize(
        REFRESH_COOKIE,
        tokens.refresh,
        REFRESH_COOKIE_PATH,
        REFRESH_TTL_SECONDS,
      ),
    ]);
  }

  /** Expires both cookies with the exact attributes they were set with.
   * Logout
   */
  clear(reply: FastifyReply): void {
    void reply.header('set-cookie', [
      this.serialize(ACCESS_COOKIE, '', ACCESS_COOKIE_PATH, 0),
      this.serialize(REFRESH_COOKIE, '', REFRESH_COOKIE_PATH, 0),
    ]);
  }

  // update tokens
  read(request: FastifyRequest, name: string): string | undefined {
    const header = request.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(';')) {
      const separator = part.indexOf('=');
      if (separator > 0 && part.slice(0, separator).trim() === name) {
        return part.slice(separator + 1).trim() || undefined;
      }
    }
    return undefined;
  }

  private serialize(
    name: string,
    value: string,
    path: string,
    maxAge: number,
  ): string {
    const sameSite =
      String(this.config.get('AUTH_COOKIE_CROSS_SITE')) === 'true'
        ? 'None'
        : 'Strict';
    const parts = [`${name}=${value}`, `Path=${path}`, `Max-Age=${maxAge}`];
    if (maxAge === 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    parts.push('HttpOnly', 'Secure', `SameSite=${sameSite}`);
    return parts.join('; ');
  }
}
