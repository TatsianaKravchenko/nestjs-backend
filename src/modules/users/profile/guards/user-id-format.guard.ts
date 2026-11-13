import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { invalidRequest } from '@/modules/auth/errors/auth.errors';

/** 1-128 ASCII letters, digits, `_` or `-`. */
export const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * First guard of the profile routes: input validation runs before the token
 * is even looked at, so a malformed `userId` is always 400.
 */
@Injectable()
export class UserIdFormatGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const { userId } = request.params as { userId?: unknown };
    if (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) {
      throw invalidRequest('Invalid user id');
    }
    return true;
  }
}
