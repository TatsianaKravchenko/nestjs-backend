import { Logger } from '@nestjs/common';

import { ownershipDenied } from '../errors/auth.errors';

export interface OwnershipContext {
  requestId: string;
  operation: string;
  /** Id of the resource; safe to log because it was already read with permission. */
  targetId: string;
}

const logger = new Logger('AuthAudit');

/**
 * Verifies that the authenticated user (`actorUserId`) owns the target resource (`ownerId`).
 * Call this inside the service/handler ONLY AFTER the general RBAC permission check
 * has passed and the resource has been loaded from the DB.
 * Throws 403 `ownership_denied` if IDs do not match (without leaking whether the resource exists).
 */
export function assertOwner(
  actorUserId: string,
  ownerId: string,
  context?: OwnershipContext,
): void {
  if (actorUserId === ownerId) return;
  logger.warn({
    event: 'ownership.denied',
    category: 'ownership_denied',
    status: 403,
    actorUserId,
    ...context,
  });
  throw ownershipDenied();
}
