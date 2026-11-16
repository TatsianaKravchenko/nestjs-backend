import { Controller, Get, Header, Param, Req, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { PROBLEM_DETAILS_SCHEMA } from '@/modules/auth/errors/auth.errors';
import type { RbacRequest } from '@/modules/rbac/rbac.types';

import { UserIdFormatGuard } from '../../profile/guards/user-id-format.guard';
import { DeletionStatusDto } from '../dto/deletion.dto';
import {
  DeletionRoute,
  DeletionStatusRateGuard,
} from '../guards/deletion-access.guard';
import { DeletionStatusService } from '../services/deletion-status.service';
import { RECEIPT_HEADER } from '../utils/deletion-support';

const problem = (status: number, description: string) =>
  ApiResponse({
    status,
    description,
    content: { 'application/problem+json': { schema: PROBLEM_DETAILS_SCHEMA } },
  });

/**
 * Check order: `UserIdFormatGuard` (400) -> IP rate limit (429) -> with a
 * `Deletion-Receipt` header the handler decides (404); without one: session
 * (401), CSRF, `users@delete` and `users@delete_any` (403), then the lookup.
 */
@ApiTags('users')
@ApiParam({
  name: 'userId',
  description: '1-128 characters: letters, digits, `_`, `-`.',
  example: '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44',
})
@Controller('users')
@UseGuards(UserIdFormatGuard, DeletionStatusRateGuard)
export class DeletionStatusController {
  constructor(private readonly statuses: DeletionStatusService) {}

  @Get(':userId/deletion-status')
  @DeletionRoute('status')
  @Header('Cache-Control', 'no-store')
  @ApiCookieAuth('access_token')
  @ApiOperation({
    summary: 'Status of an account deletion',
    description:
      'Self: send `Deletion-Receipt` (the job id); cookies are not read. ' +
      'Administrator: active session with users@delete and users@delete_any. ' +
      'Returns the status only.',
  })
  @ApiHeader({
    name: 'Deletion-Receipt',
    required: false,
    description: 'The jobId of the deletion (self branch).',
  })
  @ApiOkResponse({ type: DeletionStatusDto })
  @problem(400, 'Malformed userId.')
  @problem(401, 'Administrator branch: missing or invalid session.')
  @problem(403, 'Administrator branch: missing permission or CSRF failed.')
  @problem(404, 'Unknown target, job or receipt (all the same answer).')
  @problem(429, 'More than 60 requests per IP and minute.')
  async status(
    @Param('userId') userId: string,
    @Req() request: RbacRequest,
  ): Promise<DeletionStatusDto> {
    const receipt = request.headers[RECEIPT_HEADER];
    const status =
      receipt === undefined
        ? await this.statuses.byUser(userId)
        : await this.statuses.byReceipt(
            userId,
            typeof receipt === 'string' ? receipt : '',
          );
    return { status };
  }
}
