import { HttpException } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';
import { serviceUnavailable } from '@/modules/auth/errors/auth.errors';
import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';

export const PG_UNIQUE_VIOLATION = '23505';

export const isUniqueViolation = (error: unknown): boolean =>
  (error as { driverError?: { code?: string } })?.driverError?.code ===
  PG_UNIQUE_VIOLATION;

export const LOCK = { mode: 'pessimistic_write' } as const;

export interface MutationContext {
  requestId: string;
  actorUserId: string;
  targetUserId: string;
}

export function publicBaseUrl(config: ConfigService): string {
  return (
    config.get('API_PUBLIC_URL') || `http://localhost:${config.get('PORT')}`
  );
}

/** Database trouble is a retryable 503, never a leaked 500. */
export async function withDb<T>(
  audit: AuthAuditService,
  ctx: { requestId: string },
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpException) throw error;
    audit.error('users.database_unavailable', { requestId: ctx.requestId });
    throw serviceUnavailable();
  }
}
