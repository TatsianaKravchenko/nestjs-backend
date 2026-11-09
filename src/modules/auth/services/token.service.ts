import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';

import { ConfigService } from '@/core/config/config.service';

import { AuthAuditService } from './auth-audit.service';
import {
  ACCESS_TTL_SECONDS,
  CLOCK_TOLERANCE_SECONDS,
  REFRESH_TTL_SECONDS,
} from '../constants/auth.constants';
import {
  JwtErrorMessage,
  JwtErrorName,
  serviceUnavailable,
  TokenFailureReason,
} from '../errors/auth.errors';

export type TokenUse = 'access' | 'refresh';

export interface TokenPair {
  access: string;
  refresh: string;
}

interface Claims {
  sub?: unknown;
  iat?: unknown;
  exp?: unknown;
  token_use?: unknown;
}

/** Internal only: the client always receives the generic `invalid_session`. */
export class InvalidTokenError extends Error {
  constructor(readonly reason: TokenFailureReason) {
    super(`Invalid token: ${reason}`);
  }
}

function failureReason(error: unknown): TokenFailureReason {
  const { name, message } = error as { name?: string; message?: string };
  if (name === JwtErrorName.TokenExpired) return TokenFailureReason.Expired;
  if (name === JwtErrorName.NotBefore) return TokenFailureReason.Claims;
  if (
    message === JwtErrorMessage.InvalidSignature ||
    message === JwtErrorMessage.SignatureRequired
  )
    return TokenFailureReason.Signature;
  if (
    message?.startsWith(JwtErrorMessage.IssuerPrefix) ||
    message?.startsWith(JwtErrorMessage.AudiencePrefix)
  )
    return TokenFailureReason.Claims;
  return TokenFailureReason.Malformed;
}

/**
 * HS256 access/refresh tokens with separate keys. The payload carries only
 * `sub`, `iss`, `aud`, `iat`, `exp` and `token_use`: no roles, email or jti.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuthAuditService,
  ) {}

  /** Both tokens are built before anything is sent; a failure leaves no partial state (503). */
  async issuePair(userId: string): Promise<TokenPair> {
    try {
      const [access, refresh] = await Promise.all([
        this.sign(userId, 'access'),
        this.sign(userId, 'refresh'),
      ]);
      return { access, refresh };
    } catch {
      this.audit.error('token.signing_unavailable', { userId });
      throw serviceUnavailable('Could not create a session');
    }
  }

  verifyAccess(token: string | undefined): Promise<string> {
    return this.verify(token, 'access');
  }

  verifyRefresh(token: string | undefined): Promise<string> {
    return this.verify(token, 'refresh');
  }

  private sign(userId: string, use: TokenUse): Promise<string> {
    return this.jwt.signAsync(
      { token_use: use },
      {
        algorithm: 'HS256',
        secret: this.secret(use),
        subject: userId,
        issuer: this.config.get('JWT_ISSUER'),
        audience: this.config.get('JWT_AUDIENCE'),
        expiresIn: use === 'access' ? ACCESS_TTL_SECONDS : REFRESH_TTL_SECONDS,
      },
    );
  }

  /** Resolves with the user id (`sub`) of a valid token of the expected kind. */
  private async verify(
    token: string | undefined,
    use: TokenUse,
  ): Promise<string> {
    if (!token) throw new InvalidTokenError(TokenFailureReason.Missing);

    let claims: Claims;
    try {
      claims = await this.jwt.verifyAsync<Claims>(token, {
        algorithms: ['HS256'],
        secret: this.secret(use),
        issuer: this.config.get('JWT_ISSUER'),
        audience: this.config.get('JWT_AUDIENCE'),
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
    } catch (error) {
      throw new InvalidTokenError(failureReason(error));
    }

    if (claims.token_use !== use)
      throw new InvalidTokenError(TokenFailureReason.TokenUse);
    if (
      typeof claims.sub !== 'string' ||
      !isUUID(claims.sub) ||
      typeof claims.iat !== 'number' ||
      typeof claims.exp !== 'number'
    ) {
      throw new InvalidTokenError(TokenFailureReason.Claims);
    }
    return claims.sub;
  }

  private secret(use: TokenUse): string {
    return this.config.get(
      use === 'access' ? 'JWT_ACCESS_SECRET' : 'JWT_REFRESH_SECRET',
    );
  }
}
