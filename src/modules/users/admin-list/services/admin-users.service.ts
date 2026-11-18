import { Injectable, HttpException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import { serviceUnavailable } from '@/modules/auth/errors/auth.errors';
import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';

import { UserProfileDto } from '../../dto/user-profile.dto';
import { UserStatus } from '../../entities/user.entity';
import { photoUrlFor } from '../../user-profile.projector';
import type { ListUsersQuery } from '../dto/list-users-query.dto';
import type { ListUsersResponseDto } from '../dto/list-users-response.dto';
import { escapeLike } from '../utils/user-search';
import {
  CURSOR_TTL_MS,
  type CursorPayload,
  UserListCursorService,
} from './user-list-cursor.service';

export interface ListContext {
  requestId: string;
  actorUserId: string;
}

/** Safe columns only: `password_hash` and `photo_key` are never selected (only whether a photo exists). */
interface ListRow {
  id: string;
  email: string;
  display_name: string | null;
  has_photo: boolean;
  status: UserStatus;
  created_at: Date;
  updated_at: Date;
  created_at_us: string;
}

const QUERY_TIMEOUT_MS = 2000;
/** Microsecond-precision UTC text: JS dates would truncate and break keyset comparisons. */
const TIMESTAMP_FORMAT = `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`;

/**
 * Admin user list with signed keyset pagination over a snapshot of the table.
 * The first page captures `snapshotAt` from the DB clock; every page filters
 * `created_at < snapshotAt`, so rows created meanwhile never shift pages.
 * Audit events carry ids, parameter names, page size, `hasNext` and duration:
 * never the search text, cursor, emails or names.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly cursors: UserListCursorService,
    private readonly audit: AuthAuditService,
    private readonly config: ConfigService,
  ) {}

  async list(
    ctx: ListContext,
    query: ListUsersQuery,
  ): Promise<ListUsersResponseDto> {
    const started = Date.now();
    const base = {
      requestId: ctx.requestId,
      actorUserId: ctx.actorUserId,
      params: query.paramNames.join(','),
    };

    try {
      const response = await this.run(query);
      this.audit.info('users.admin_list', {
        ...base,
        result: 'success',
        pageSize: response.items.length,
        hasNext: response.nextCursor !== null,
        durationMs: Date.now() - started,
      });
      return response;
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : 503;
      this.audit.warn('users.admin_list.failed', {
        ...base,
        result: status === 400 ? 'invalid_request' : 'unavailable',
        status,
        durationMs: Date.now() - started,
      });
      if (error instanceof HttpException) throw error;
      throw serviceUnavailable();
    }
  }

  private async run(query: ListUsersQuery): Promise<ListUsersResponseDto> {
    this.cursors.assertConfigured();
    const shape = {
      search: query.search,
      status: query.status,
      sort: query.sort,
      order: query.order,
    };
    const position = query.cursor
      ? this.cursors.verify(query.cursor, shape)
      : undefined;

    // An id that is not a uuid cannot exist (and would make the query fail).
    if (query.search?.by === 'id' && !isUUID(query.search.value)) {
      return { items: [], nextCursor: null };
    }

    const { rows, snapshotAt } = await this.query(query, position);
    const hasNext = rows.length > query.limit;
    const page = hasNext ? rows.slice(0, query.limit) : rows;
    const baseUrl = this.publicBaseUrl();
    const items = page.map((row) => this.project(row, baseUrl));

    let nextCursor: string | null = null;
    if (hasNext) {
      const last = page[page.length - 1];
      const issuedAt = position?.issuedAt ?? Date.now();
      nextCursor = this.cursors.issue(shape, {
        snapshotAt,
        lastSortValue:
          query.sort === 'createdAt' ? last.created_at_us : last.id,
        lastTieBreaker:
          query.sort === 'createdAt' ? last.id : last.created_at_us,
        issuedAt,
        expiresAt: position?.expiresAt ?? issuedAt + CURSOR_TTL_MS,
      });
    }
    return { items, nextCursor };
  }

  /** One short transaction: statement timeout, snapshot (first page), page query. */
  private async query(
    query: ListUsersQuery,
    position: CursorPayload | undefined,
  ): Promise<{ rows: ListRow[]; snapshotAt: string }> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        await manager.query(
          `SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`,
        );
        const snapshotAt =
          position?.snapshotAt ?? (await this.captureSnapshot(manager));
        const { sql, params } = this.buildSql(query, position, snapshotAt);
        const rows = await manager.query<ListRow[]>(sql, params);
        return { rows, snapshotAt };
      });
    } catch {
      // Statement timeout (2 s, SQLSTATE 57014) and any other database failure.
      throw serviceUnavailable('User list is temporarily unavailable');
    }
  }

  private async captureSnapshot(manager: EntityManager): Promise<string> {
    const rows = await manager.query<{ snapshot_at: string }[]>(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', '${TIMESTAMP_FORMAT}') AS snapshot_at`,
    );
    return rows[0].snapshot_at;
  }

  private buildSql(
    query: ListUsersQuery,
    position: CursorPayload | undefined,
    snapshotAt: string,
  ): { sql: string; params: unknown[] } {
    const params: unknown[] = [snapshotAt];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = ['created_at < $1::timestamptz'];

    if (query.status) where.push(`status = ${bind(query.status)}`);
    if (query.search?.by === 'id') {
      where.push(`id = ${bind(query.search.value)}::uuid`);
    } else if (query.search?.by === 'email') {
      where.push(
        `email LIKE ${bind(`${escapeLike(query.search.value)}%`)} ESCAPE '\\'`,
      );
    } else if (query.search?.by === 'displayName') {
      where.push(
        `display_name IS NOT NULL AND lower(normalize(display_name, NFC)) LIKE ${bind(`${escapeLike(query.search.value)}%`)} ESCAPE '\\'`,
      );
    }

    const dir = query.order === 'asc' ? 'ASC' : 'DESC';
    const cmp = query.order === 'asc' ? '>' : '<';
    const [first, second] =
      query.sort === 'createdAt' ? ['created_at', 'id'] : ['id', 'created_at'];
    if (position) {
      const cast = (column: string) =>
        column === 'id' ? '::uuid' : '::timestamptz';
      where.push(
        `(${first}, ${second}) ${cmp} (${bind(position.lastSortValue)}${cast(first)}, ${bind(position.lastTieBreaker)}${cast(second)})`,
      );
    }

    const limit = bind(query.limit + 1);
    const sql = `SELECT id, email, display_name, (photo_key IS NOT NULL) AS has_photo, status, created_at, updated_at,
       to_char(created_at AT TIME ZONE 'UTC', '${TIMESTAMP_FORMAT}') AS created_at_us
       FROM users
       WHERE ${where.join(' AND ')}
       ORDER BY ${first} ${dir}, ${second} ${dir}
       LIMIT ${limit}`;
    return { sql, params };
  }

  private project(row: ListRow, baseUrl: string): UserProfileDto {
    const servable =
      row.has_photo &&
      row.status !== UserStatus.DELETING &&
      row.status !== UserStatus.DELETED;
    const dto = new UserProfileDto();
    dto.id = row.id;
    dto.email = row.email;
    dto.displayName = row.display_name ?? null;
    dto.photoUrl = servable ? photoUrlFor(row.id, baseUrl) : null;
    dto.status = row.status;
    dto.createdAt = new Date(row.created_at).toISOString();
    dto.updatedAt = new Date(row.updated_at).toISOString();
    return dto;
  }

  private publicBaseUrl(): string {
    return (
      this.config.get('API_PUBLIC_URL') ||
      `http://localhost:${this.config.get('PORT')}`
    );
  }
}
