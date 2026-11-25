import { HttpException, Inject, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { performance } from 'perf_hooks';
import { DataSource } from 'typeorm';

import {
  fileNotReady,
  notFound,
  serviceUnavailable,
} from '@/modules/auth/errors/auth.errors';

import { storedFileType } from '../utils/stored-file-types';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
  type StoredObject,
} from './object-storage';
import { TransformationAuditService } from './transformation-audit.service';

export interface DownloadContext {
  requestId: string;
  /** From the JWT `sub` (set by the guards), never from the request. */
  actorUserId: string;
  /** Set only on the administrator route. */
  targetUserId?: string;
}

export interface DownloadResult extends StoredObject {
  contentType: string;
  extension: string;
}

interface DownloadRow {
  status: string;
  target_format: string;
  storage_status: string;
  stored_file_key: string | null;
  stored_file_until: Date | null;
}

const QUERY_TIMEOUT_MS = 2000;

/**
 * Opens the stored file of one history item. The caller's guards have already
 * checked the session and the permission, so nothing here runs without them.
 * The item is always looked up by id AND owner (the session user, or the target
 * of the administrator route), so another user's item is just a 404.
 *
 * 404: no such item, not the owner's, not saved, failed or expired.
 * 409 `file_not_ready`: still being stored. 503: the database is down, or the
 * object is missing although the row says it exists. Nothing in an answer or in
 * the audit log names a key, a path or a bucket.
 */
@Injectable()
export class StoredFileDownloadService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: TransformationAuditService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async open(ctx: DownloadContext, itemId: string): Promise<DownloadResult> {
    const started = performance.now();
    const ownerId = ctx.targetUserId ?? ctx.actorUserId;
    const log = (
      outcome: 'success' | 'not_found' | 'not_ready' | 'unavailable',
      extra: { size?: number; errorCode?: string } = {},
    ): void =>
      this.audit.storage(
        outcome === 'success' || outcome === 'not_found' ? 'log' : 'warn',
        'transformation.stored_file.download',
        {
          requestId: ctx.requestId,
          userId: ownerId,
          ...(ctx.targetUserId === undefined
            ? {}
            : { actorUserId: ctx.actorUserId }),
          ...(isUUID(itemId) ? { transformationId: itemId } : {}),
          action: 'download',
          outcome,
          ...extra,
          durationMs: Math.round(performance.now() - started),
        },
      );

    try {
      const result = await this.run(ctx, itemId, ownerId);
      log('success', { size: result.size });
      return result;
    } catch (error) {
      if (error instanceof HttpException) {
        const status = error.getStatus();
        log(
          status === 404
            ? 'not_found'
            : status === 409
              ? 'not_ready'
              : 'unavailable',
          status === 503 ? { errorCode: 'storage_unavailable' } : {},
        );
        throw error;
      }
      log('unavailable', { errorCode: 'storage_unavailable' });
      throw serviceUnavailable('The file is temporarily unavailable');
    }
  }

  private async run(
    ctx: DownloadContext,
    itemId: string,
    ownerId: string,
  ): Promise<DownloadResult> {
    // An id that is not a uuid cannot exist (and would make the query fail).
    if (!isUUID(itemId) || !isUUID(ownerId)) throw notFound('File not found');

    // RBAC already passed. Only now may the target's existence be revealed.
    if (ctx.targetUserId !== undefined && !(await this.userExists(ownerId))) {
      throw notFound('File not found');
    }

    const row = await this.find(itemId, ownerId);
    if (!row || row.status !== 'success') throw notFound('File not found');
    if (row.storage_status === 'pending') throw fileNotReady();
    if (
      row.storage_status !== 'available' ||
      !row.stored_file_key ||
      !row.stored_file_until ||
      new Date(row.stored_file_until).getTime() <= Date.now()
    ) {
      throw notFound('File not found');
    }

    try {
      const object = await this.storage.read(row.stored_file_key);
      return { ...object, ...storedFileType(row.target_format) };
    } catch {
      // A missing object although the row has a key is a storage fault, not a 404.
      throw serviceUnavailable('The file is temporarily unavailable');
    }
  }

  private async userExists(userId: string): Promise<boolean> {
    try {
      const rows: unknown[] = await this.dataSource.query(
        'SELECT 1 FROM users WHERE id = $1 LIMIT 1',
        [userId],
      );
      return rows.length > 0;
    } catch {
      throw serviceUnavailable('The file is temporarily unavailable');
    }
  }

  private async find(
    itemId: string,
    ownerId: string,
  ): Promise<DownloadRow | undefined> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        await manager.query(
          `SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`,
        );
        const rows = await manager.query<DownloadRow[]>(
          `SELECT status, target_format, storage_status, stored_file_key,
                  stored_file_until
             FROM transformations
            WHERE id = $1 AND user_id = $2`,
          [itemId, ownerId],
        );
        return rows[0];
      });
    } catch {
      throw serviceUnavailable('The file is temporarily unavailable');
    }
  }
}
