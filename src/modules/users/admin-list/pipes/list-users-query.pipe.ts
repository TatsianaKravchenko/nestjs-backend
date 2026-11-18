import { PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import {
  ApiErrorCode,
  invalidRequest,
} from '@/modules/auth/errors/auth.errors';

import {
  DEFAULT_LIMIT,
  LIST_QUERY_FIELDS,
  ListUsersQuery,
  ListUsersQueryDto,
} from '../dto/list-users-query.dto';
import { normalizeSearch } from '../utils/user-search';

const bad = (message: string) =>
  invalidRequest(message, ApiErrorCode.ValidationError);

/**
 * Strict whitelist for `GET /admin/users`: unknown and duplicate parameters,
 * out-of-range values (no clamping) and a `searchBy`/`q` pair with one half
 * missing are all 400. Runs after the access guards, so the query is never
 * inspected for a caller without `users@list`.
 */
export class ListUsersQueryPipe implements PipeTransform {
  transform(value: unknown): ListUsersQuery {
    const raw = value && typeof value === 'object' ? value : {};
    const entries = Object.entries(raw as Record<string, unknown>);

    const allowed: readonly string[] = LIST_QUERY_FIELDS;
    const unknown = entries.filter(([name]) => !allowed.includes(name));
    if (unknown.length > 0) {
      throw bad(`Unknown parameter: ${unknown.map(([n]) => n).join(', ')}`);
    }
    for (const [name, v] of entries) {
      if (typeof v !== 'string') throw bad(`Invalid or repeated ${name}`);
    }

    const dto = plainToInstance(ListUsersQueryDto, raw);
    const errors = validateSync(dto, { forbidUnknownValues: true });
    if (errors.length > 0) {
      throw bad(
        `Invalid parameter: ${errors.map((e) => e.property).join(', ')}`,
      );
    }

    if ((dto.searchBy === undefined) !== (dto.q === undefined)) {
      throw bad('searchBy and q must be sent together');
    }
    if (dto.cursor !== undefined && dto.cursor === '') {
      throw bad('Invalid parameter: cursor');
    }

    return {
      cursor: dto.cursor,
      limit: dto.limit ?? DEFAULT_LIMIT,
      search:
        dto.searchBy !== undefined && dto.q !== undefined
          ? normalizeSearch(dto.searchBy, dto.q)
          : undefined,
      status: dto.status,
      sort: dto.sort ?? 'createdAt',
      order: dto.order ?? 'desc',
      paramNames: entries.map(([name]) => name).sort(),
    };
  }
}
