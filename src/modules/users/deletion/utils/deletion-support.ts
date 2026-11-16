import { HttpException } from '@nestjs/common';
import { randomBytes } from 'crypto';

import { serviceUnavailable } from '@/modules/auth/errors/auth.errors';
import type { AuthAuditService } from '@/modules/auth/services/auth-audit.service';

import type { DeletionJob } from '../entities/deletion-job.entity';

export const RECEIPT_HEADER = 'deletion-receipt';
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** The path only: neither the job id nor the receipt is part of the URL. */
export const statusUrl = (userId: string): string =>
  `/users/${userId}/deletion-status`;

export const newJobId = (): string => randomBytes(16).toString('hex');

/** Unique, unroutable (RFC 2606) and unrelated to the original address. */
export const newTombstoneEmail = (): string =>
  `deleted-${randomBytes(16).toString('hex')}@example.invalid`;

export interface DeletionAccepted {
  jobId: string;
  statusUrl: string;
  status: DeletionJob['status'];
}

export const accepted = (
  job: Pick<DeletionJob, 'id' | 'status' | 'userId'>,
): DeletionAccepted => ({
  jobId: job.id,
  statusUrl: statusUrl(job.userId),
  status: job.status,
});

/** Database trouble is a retryable 503; the log names the event only. */
export async function withDeletionDb<T>(
  audit: AuthAuditService,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpException) throw error;
    audit.error('users.deletion.database_unavailable');
    throw serviceUnavailable();
  }
}
