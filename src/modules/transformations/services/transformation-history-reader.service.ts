import { HttpException, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource } from 'typeorm';

import {
  notFound,
  serviceUnavailable,
} from '@/modules/auth/errors/auth.errors';
import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';

import type { HistoryFilters, HistoryQuery } from '../dto/history-query.dto';
import type {
  TransformationHistoryItemDto,
  TransformationHistoryResponseDto,
} from '../dto/history-response.dto';
import type {
  TransformationStatus,
  TransformationType,
} from '../entities/transformation.entity';
import {
  canonicalQuery,
  decodeCursor,
  encodeCursor,
} from '../utils/history-cursor';

export interface HistoryContext {
  requestId: string;
  /** From the JWT `sub` (set by the guards), never from the query. */
  actorUserId: string;
  /** Set only on the administrator route. */
  targetUserId?: string;
}

/** Safe columns only: no `user_id`, and nothing from `transformation_objects`. */
interface HistoryRow {
  id: string;
  type: TransformationType;
  source_format: string;
  target_format: string;
  status: TransformationStatus;
  input_size: string;
  output_size: string | null;
  duration_ms: number;
  error_code: string | null;
  created_at: Date;
  created_at_us: string;
}

const QUERY_TIMEOUT_MS = 2000;
const TIMESTAMP_FORMAT = `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`;

/**
 * Read side of the history: keyset pagination over
 * `(user_id, created_at DESC, id DESC)`, never OFFSET. It fetches one row more
 * than `limit` to know whether a next page exists. Audit events carry ids,
 * the names of the filters used, the page size, the item count, the outcome
 * and the duration: never values of filters, the cursor, e-mails or file names.
 */
@Injectable()
export class TransformationHistoryReader {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuthAuditService,
  ) {}

  async list(
    ctx: HistoryContext,
    query: HistoryQuery,
  ): Promise<TransformationHistoryResponseDto> {
    const started = Date.now();
    const admin = ctx.targetUserId !== undefined;
    const base = {
      requestId: ctx.requestId,
      actorUserId: ctx.actorUserId,
      mode: admin ? 'admin' : 'self',
      ...(admin ? { targetUserId: ctx.targetUserId } : {}),
      filters: this.filterNames(query.filters),
      limit: query.limit,
    };

    try {
      const response = await this.run(ctx, query);
      this.audit.info('transformations.history.list', {
        ...base,
        itemCount: response.items.length,
        hasNext: response.nextCursor !== null,
        result: 'success',
        durationMs: Date.now() - started,
      });
      return response;
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : 503;
      this.audit.warn('transformations.history.list_failed', {
        ...base,
        result:
          status === 400
            ? 'invalid_request'
            : status === 404
              ? 'not_found'
              : 'unavailable',
        status,
        durationMs: Date.now() - started,
      });
      if (error instanceof HttpException) throw error;
      throw serviceUnavailable('History is temporarily unavailable');
    }
  }

  private async run(
    ctx: HistoryContext,
    query: HistoryQuery,
  ): Promise<TransformationHistoryResponseDto> {
    const canonical = canonicalQuery(query.limit, query.filters);
    const position = query.cursor
      ? decodeCursor(query.cursor, canonical)
      : undefined;

    const userId = ctx.targetUserId ?? ctx.actorUserId;
    // RBAC already passed. Only now may the target's existence be revealed.
    if (ctx.targetUserId !== undefined && !(await this.userExists(userId))) {
      throw notFound('User not found');
    }

    const rows = await this.fetch(userId, query, position);
    const hasNext = rows.length > query.limit;
    const page = hasNext ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map((row) => this.project(row)),
      nextCursor:
        hasNext && last
          ? encodeCursor(
              { createdAt: last.created_at_us, id: last.id },
              canonical,
            )
          : null,
    };
  }

  private async userExists(userId: string): Promise<boolean> {
    // An id that is not a uuid cannot exist (and would make the query fail).
    if (!isUUID(userId)) return false;
    try {
      const rows: unknown[] = await this.dataSource.query(
        'SELECT 1 FROM users WHERE id = $1 LIMIT 1',
        [userId],
      );
      return rows.length > 0;
    } catch {
      throw serviceUnavailable('History is temporarily unavailable');
    }
  }

  private async fetch(
    userId: string,
    query: HistoryQuery,
    position: { createdAt: string; id: string } | undefined,
  ): Promise<HistoryRow[]> {
    const params: unknown[] = [userId];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = ['user_id = $1'];
    const { filters } = query;
    if (filters.type) where.push(`type = ${bind(filters.type)}`);
    if (filters.sourceFormat) {
      where.push(`source_format = ${bind(filters.sourceFormat)}`);
    }
    if (filters.targetFormat) {
      where.push(`target_format = ${bind(filters.targetFormat)}`);
    }
    if (filters.status) where.push(`status = ${bind(filters.status)}`);
    if (filters.createdAtFrom) {
      where.push(`created_at >= ${bind(filters.createdAtFrom)}::timestamptz`);
    }
    if (filters.createdAtTo) {
      where.push(`created_at < ${bind(filters.createdAtTo)}::timestamptz`);
    }
    if (position) {
      where.push(
        `(created_at, id) < (${bind(position.createdAt)}::timestamptz, ${bind(position.id)}::uuid)`,
      );
    }
    const sql = `SELECT id, type, source_format, target_format, status,
              input_size, output_size, duration_ms, error_code, created_at,
              to_char(created_at AT TIME ZONE 'UTC', '${TIMESTAMP_FORMAT}') AS created_at_us
         FROM transformations
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT ${bind(query.limit + 1)}`;

    try {
      return await this.dataSource.transaction(async (manager) => {
        await manager.query(
          `SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`,
        );
        return manager.query<HistoryRow[]>(sql, params);
      });
    } catch {
      throw serviceUnavailable('History is temporarily unavailable');
    }
  }

  /** `storage*` fields are constants until task 2.4 (object storage). */
  private project(row: HistoryRow): TransformationHistoryItemDto {
    return {
      id: row.id,
      type: row.type,
      sourceFormat: row.source_format,
      targetFormat: row.target_format,
      status: row.status,
      inputSize: Number(row.input_size),
      outputSize: row.output_size === null ? null : Number(row.output_size),
      durationMs: row.duration_ms,
      errorCode: row.error_code,
      createdAt: new Date(row.created_at).toISOString(),
      storageStatus: 'not_requested',
      hasStoredFile: false,
      fileExpiresAt: null,
    };
  }

  /** Names of the filters in use (never their values), in a stable order. */
  private filterNames(filters: HistoryFilters): string {
    return (Object.keys(filters) as (keyof HistoryFilters)[])
      .filter((name) => filters[name] !== null)
      .join(',');
  }
}
