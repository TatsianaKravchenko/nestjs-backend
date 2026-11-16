import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource } from 'typeorm';

import { notFound } from '@/modules/auth/errors/auth.errors';
import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';

import { DeletionJob, JOB_ID_PATTERN } from '../entities/deletion-job.entity';
import { withDeletionDb } from '../utils/deletion-support';

/**
 * Reads the status of a deletion job. A receipt (the job id) proves the
 * caller started the deletion; a wrong, malformed or unknown receipt and an
 * unknown target are all the same 404. Only the status leaves the service.
 */
@Injectable()
export class DeletionStatusService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuthAuditService,
  ) {}

  /** Self branch: the receipt must be the job of this user. */
  async byReceipt(
    userId: string,
    receipt: string,
  ): Promise<DeletionJob['status']> {
    if (!isUUID(userId) || !JOB_ID_PATTERN.test(receipt)) {
      throw notFound('Deletion not found');
    }
    return this.find({ id: receipt, userId });
  }

  /** Administrator branch: the job of the target user. */
  async byUser(userId: string): Promise<DeletionJob['status']> {
    if (!isUUID(userId)) throw notFound('Deletion not found');
    return this.find({ userId });
  }

  private async find(where: {
    id?: string;
    userId: string;
  }): Promise<DeletionJob['status']> {
    const job = await withDeletionDb(this.audit, () =>
      this.dataSource.getRepository(DeletionJob).findOne({
        where,
        select: { id: true, status: true },
      }),
    );
    if (!job) throw notFound('Deletion not found');
    return job.status;
  }
}
