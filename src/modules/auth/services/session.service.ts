import { Injectable } from '@nestjs/common';

import { User, UserStatus } from '@/modules/users/entities/user.entity';
import { UsersService } from '@/modules/users/users.service';

import { AuthAuditService, RequestContext } from './auth-audit.service';
import {
  authorizationUnavailable,
  invalidSession,
  serviceUnavailable,
  TokenFailureReason,
} from '../errors/auth.errors';
import { InvalidTokenError, TokenPair, TokenService } from './token.service';

/**
 * Turns a token into a trusted user id. Every check re-reads the user, so a
 * user who is no longer `active` loses access and refresh immediately.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly tokens: TokenService,
    private readonly users: UsersService,
    private readonly audit: AuthAuditService,
  ) {}

  /** The shared access-token check. Resolves with the verified `userId`. */
  async authenticate(
    accessToken: string | undefined,
    ctx?: Partial<RequestContext>,
  ): Promise<string> {
    const userId = await this.verifiedActiveUser(
      this.tokens.verifyAccess(accessToken),
      'access.rejected',
      ctx,
    );
    return userId;
  }

  /** Rotates both tokens. The used refresh token is not stored or revoked. */
  async refresh(
    refreshToken: string | undefined,
    ctx: RequestContext,
  ): Promise<TokenPair> {
    const userId = await this.verifiedActiveUser(
      this.tokens.verifyRefresh(refreshToken),
      'refresh.failed',
      ctx,
    );
    const pair = await this.tokens.issuePair(userId);
    this.audit.info('refresh.success', { userId, requestId: ctx.requestId });
    return pair;
  }

  private async verifiedActiveUser(
    verification: Promise<string>,
    failureEvent: string,
    ctx?: Partial<RequestContext>,
  ): Promise<string> {
    let userId: string;
    try {
      userId = await verification;
    } catch (error) {
      if (!(error instanceof InvalidTokenError)) throw error;
      this.reject(failureEvent, error.reason, ctx);
    }

    let user: Pick<User, 'id' | 'status'> | null;
    try {
      user = await this.users.findAuthState(userId);
    } catch {
      this.audit.error('auth.database_unavailable', {
        category: 'users',
        status: 503,
        requestId: ctx?.requestId,
      });
      throw failureEvent === 'access.rejected'
        ? authorizationUnavailable()
        : serviceUnavailable();
    }

    if (!user || user.status !== UserStatus.ACTIVE) {
      this.reject(failureEvent, TokenFailureReason.UserInactive, ctx, userId);
    }
    return userId;
  }

  private reject(
    event: string,
    reason: TokenFailureReason,
    ctx?: Partial<RequestContext>,
    userId?: string,
  ): never {
    this.audit.warn(event, {
      category: reason,
      reason,
      status: 401,
      userId,
      requestId: ctx?.requestId,
    });
    throw invalidSession();
  }
}
