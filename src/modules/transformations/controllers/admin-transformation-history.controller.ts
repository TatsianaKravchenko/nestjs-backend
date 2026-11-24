import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import {
  TRANSFORMATIONS_HISTORY_ANY_ACTION,
  TRANSFORMATIONS_PERMISSION,
} from '@/modules/rbac/rbac.constants';
import { RequirePermission } from '@/modules/rbac/rbac.decorators';
import type { RbacRequest } from '@/modules/rbac/rbac.types';

import type { HistoryQuery } from '../dto/history-query.dto';
import { TransformationHistoryResponseDto } from '../dto/history-response.dto';
import { HistoryRateGuard } from '../guards/history-rate.guard';
import { HistoryQueryPipe } from '../pipes/history-query.pipe';
import { TransformationHistoryReader } from '../services/transformation-history-reader.service';
import {
  applyAll,
  HISTORY_QUERY_DOCS,
  problem,
} from './transformation-history.controller';

/**
 * Check order: AccessTokenGuard (401) -> CsrfGuard -> RbacGuard
 * `transformations@history_any` (403) -> `HistoryRateGuard` (429) -> query
 * validation (400) -> handler (cursor check, then target lookup, 404). The
 * permission is checked before `userId` is looked at or the `users` table is
 * read, so a caller without it cannot tell whether a user exists.
 */
@ApiTags('transformations')
@ApiCookieAuth('access_token')
@ApiParam({ name: 'userId', format: 'uuid' })
@problem(400, 'Invalid query parameter, or invalid_cursor.')
@problem(401, 'Missing, invalid or expired session, or user is not active.')
@problem(403, 'Missing transformations@history_any.')
@problem(404, 'No such user.')
@problem(429, 'More than 60 history requests per user in a minute.')
@problem(503, 'Database or policy snapshot unavailable.')
@Controller('admin/users/:userId/transformations')
@RequirePermission(
  TRANSFORMATIONS_PERMISSION,
  TRANSFORMATIONS_HISTORY_ANY_ACTION,
)
export class AdminTransformationHistoryController {
  constructor(private readonly history: TransformationHistoryReader) {}

  @Get('history')
  @UseGuards(HistoryRateGuard)
  @ApiOperation({
    summary: 'Transformation history of any user (administrator)',
    description:
      'Same contract as `GET /transformations/history`, for the user in the path.',
  })
  @applyAll(...HISTORY_QUERY_DOCS)
  @ApiOkResponse({ type: TransformationHistoryResponseDto })
  list(
    @Param('userId') userId: string,
    @Query(HistoryQueryPipe) query: HistoryQuery,
    @Req() request: RbacRequest,
  ): Promise<TransformationHistoryResponseDto> {
    return this.history.list(
      {
        requestId: String(request.id),
        actorUserId: request.user?.id ?? '',
        targetUserId: userId,
      },
      query,
    );
  }
}
