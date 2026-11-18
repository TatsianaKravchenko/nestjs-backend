import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { PROBLEM_DETAILS_SCHEMA } from '@/modules/auth/errors/auth.errors';
import { RequirePermission } from '@/modules/rbac/rbac.decorators';
import {
  USERS_LIST_ACTION,
  USERS_PERMISSION,
} from '@/modules/rbac/rbac.constants';
import type { RbacRequest } from '@/modules/rbac/rbac.types';

import {
  DEFAULT_LIMIT,
  type ListUsersQuery,
  MAX_LIMIT,
  SORT_FIELDS,
  SORT_ORDERS,
} from '../dto/list-users-query.dto';
import { ListUsersResponseDto } from '../dto/list-users-response.dto';
import { AdminUsersRateGuard } from '../guards/admin-users-rate.guard';
import { ListUsersQueryPipe } from '../pipes/list-users-query.pipe';
import { AdminUsersService } from '../services/admin-users.service';
import { UserStatus } from '../../entities/user.entity';
import { SEARCH_BY } from '../utils/user-search';

const problem = (status: number, description: string) =>
  ApiResponse({
    status,
    description,
    content: { 'application/problem+json': { schema: PROBLEM_DETAILS_SCHEMA } },
  });

/**
 * Check order: AccessTokenGuard (JWT + active user, 401) -> CsrfGuard ->
 * RbacGuard `users@list` (403) -> `AdminUsersRateGuard` (429) -> query
 * validation (400) -> handler. The permission is checked before the query
 * string is looked at and before the `users` table is read; role names and
 * `users@read_any` are never consulted.
 */
@ApiTags('admin-users')
@ApiCookieAuth('access_token')
@problem(400, 'Invalid or repeated query parameter, or invalid_cursor.')
@problem(401, 'Missing, invalid or expired session, or user is not active.')
@problem(403, 'Missing users@list.')
@problem(429, 'More than 60 requests per actor or 120 per IP in a minute.')
@problem(
  503,
  'Database (2 s query timeout), policy snapshot or cursor keys unavailable.',
)
@Controller('admin/users')
@RequirePermission(USERS_PERMISSION, USERS_LIST_ACTION)
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @UseGuards(AdminUsersRateGuard)
  @ApiOperation({
    summary: 'List users (administrator)',
    description:
      'Keyset pagination over a snapshot taken on the first page; no total count. ' +
      'Pass `nextCursor` back as `cursor` together with the same filters, `sort` and `order` ' +
      '(`limit` may change); a cursor is valid 15 minutes from the first page. ' +
      'Only the listed query parameters are accepted, each at most once.',
  })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    minimum: 1,
    maximum: MAX_LIMIT,
    example: DEFAULT_LIMIT,
    description: `1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}; values above ${MAX_LIMIT} are rejected, not clamped.`,
  })
  @ApiQuery({
    name: 'searchBy',
    required: false,
    enum: SEARCH_BY,
    description: 'Must be sent together with `q`.',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    type: String,
    description:
      '`id`: exact, 1-128 of [a-zA-Z0-9_-]. `email`: case-insensitive literal prefix, 3-254 visible ASCII characters. ' +
      '`displayName`: case-insensitive literal prefix (NFC), 3-80 characters, no control characters.',
  })
  @ApiQuery({ name: 'status', required: false, enum: UserStatus })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: SORT_FIELDS,
    example: 'createdAt',
  })
  @ApiQuery({
    name: 'order',
    required: false,
    enum: SORT_ORDERS,
    example: 'desc',
  })
  @ApiOkResponse({ type: ListUsersResponseDto })
  list(
    @Query(new ListUsersQueryPipe()) query: ListUsersQuery,
    @Req() request: RbacRequest,
  ): Promise<ListUsersResponseDto> {
    return this.users.list(
      {
        requestId: String(request.id),
        // Set by AccessTokenGuard; the guards guarantee it is present here.
        actorUserId: request.user?.id ?? '',
      },
      query,
    );
  }
}
