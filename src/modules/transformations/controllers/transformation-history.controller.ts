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
import {
  TRANSFORMATIONS_HISTORY_ACTION,
  TRANSFORMATIONS_PERMISSION,
} from '@/modules/rbac/rbac.constants';
import { RequirePermission } from '@/modules/rbac/rbac.decorators';
import type { RbacRequest } from '@/modules/rbac/rbac.types';

import {
  DEFAULT_LIMIT,
  type HistoryQuery,
  MAX_LIMIT,
} from '../dto/history-query.dto';
import { TransformationHistoryResponseDto } from '../dto/history-response.dto';
import {
  TransformationStatus,
  TransformationType,
} from '../entities/transformation.entity';
import { HistoryRateGuard } from '../guards/history-rate.guard';
import { HistoryQueryPipe } from '../pipes/history-query.pipe';
import { TransformationHistoryReader } from '../services/transformation-history-reader.service';

export const problem = (status: number, description: string) =>
  ApiResponse({
    status,
    description,
    content: { 'application/problem+json': { schema: PROBLEM_DETAILS_SCHEMA } },
  });

/** Query parameters shared by both history routes. */
export const HISTORY_QUERY_DOCS = [
  ApiQuery({ name: 'cursor', required: false, type: String }),
  ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    minimum: 1,
    maximum: MAX_LIMIT,
    example: DEFAULT_LIMIT,
    description: `1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}; larger values are rejected, not clamped.`,
  }),
  ApiQuery({ name: 'type', required: false, enum: TransformationType }),
  ApiQuery({ name: 'sourceFormat', required: false, type: String }),
  ApiQuery({ name: 'targetFormat', required: false, type: String }),
  ApiQuery({ name: 'status', required: false, enum: TransformationStatus }),
  ApiQuery({
    name: 'createdAtFrom',
    required: false,
    type: String,
    description: 'ISO 8601 with a zone; inclusive. Must be before createdAtTo.',
  }),
  ApiQuery({
    name: 'createdAtTo',
    required: false,
    type: String,
    description: 'ISO 8601 with a zone; exclusive.',
  }),
];

export const applyAll =
  (...decorators: MethodDecorator[]): MethodDecorator =>
  (target, key, descriptor) => {
    for (const decorator of decorators) decorator(target, key, descriptor);
  };

/**
 * Check order: AccessTokenGuard (JWT + active user, 401) -> CsrfGuard ->
 * RbacGuard `transformations@history` (403) -> `HistoryRateGuard` (429) ->
 * query validation (400) -> handler. The user is always the JWT `sub`; the
 * query string has no user parameter.
 */
@ApiTags('transformations')
@ApiCookieAuth('access_token')
@problem(400, 'Invalid query parameter, or invalid_cursor.')
@problem(401, 'Missing, invalid or expired session, or user is not active.')
@problem(403, 'Missing transformations@history.')
@problem(429, 'More than 60 history requests per user in a minute.')
@problem(503, 'Database or policy snapshot unavailable.')
@Controller('transformations')
@RequirePermission(TRANSFORMATIONS_PERMISSION, TRANSFORMATIONS_HISTORY_ACTION)
export class TransformationHistoryController {
  constructor(private readonly history: TransformationHistoryReader) {}

  @Get('history')
  @UseGuards(HistoryRateGuard)
  @ApiOperation({
    summary: 'Own transformation history',
    description:
      'Newest first (`createdAt DESC, id DESC`), keyset pagination, no total count. ' +
      'Pass `nextCursor` back as `cursor` with the same `limit` and filters. ' +
      'Metadata only: no file names, contents or storage keys.',
  })
  @applyAll(...HISTORY_QUERY_DOCS)
  @ApiOkResponse({ type: TransformationHistoryResponseDto })
  list(
    @Query(HistoryQueryPipe) query: HistoryQuery,
    @Req() request: RbacRequest,
  ): Promise<TransformationHistoryResponseDto> {
    return this.history.list(
      {
        requestId: String(request.id),
        // Set by AccessTokenGuard from the JWT `sub`; the guards guarantee it.
        actorUserId: request.user?.id ?? '',
      },
      query,
    );
  }
}
