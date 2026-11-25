import { Controller, Get, HttpCode, Param, Req, Res } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import {
  TRANSFORMATIONS_DOWNLOAD_ANY_ACTION,
  TRANSFORMATIONS_PERMISSION,
} from '@/modules/rbac/rbac.constants';
import { RequirePermission } from '@/modules/rbac/rbac.decorators';
import type { RbacRequest } from '@/modules/rbac/rbac.types';

import { StoredFileDownloadService } from '../services/stored-file-download.service';
import { sendStoredFile } from './stored-file-download.controller';
import { problem } from './transformation-history.controller';

/**
 * Check order: AccessTokenGuard (401) -> CsrfGuard -> RbacGuard
 * `transformations@download_any` (403) -> handler (target user lookup, 404,
 * then the item of that user). The permission is checked before `userId` is
 * looked at or the `users` table is read, so a caller without it cannot tell
 * whether a user exists.
 */
@ApiTags('transformations')
@ApiCookieAuth('access_token')
@ApiParam({ name: 'userId', format: 'uuid' })
@ApiParam({ name: 'itemId', format: 'uuid' })
@problem(401, 'Missing, invalid or expired session, or user is not active.')
@problem(403, 'Missing transformations@download_any.')
@problem(
  404,
  'No such user or item, not saved, failed, or the file has expired.',
)
@problem(409, 'file_not_ready: the file is still being stored.')
@problem(503, 'Database or storage unavailable.')
@Controller('admin/users/:userId/transformations/history')
@RequirePermission(
  TRANSFORMATIONS_PERMISSION,
  TRANSFORMATIONS_DOWNLOAD_ANY_ACTION,
)
export class AdminStoredFileDownloadController {
  constructor(private readonly downloads: StoredFileDownloadService) {}

  @Get(':itemId/download')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Download the saved result of any user (administrator)',
    description: 'Same contract as the own download, for the user in the path.',
  })
  @ApiOkResponse({
    description: 'The stored file.',
    content: { 'application/octet-stream': {} },
  })
  async download(
    @Param('userId') userId: string,
    @Param('itemId') itemId: string,
    @Req() request: RbacRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const file = await this.downloads.open(
      {
        requestId: String(request.id),
        actorUserId: request.user?.id ?? '',
        targetUserId: userId,
      },
      itemId,
    );
    sendStoredFile(reply, file);
  }
}
