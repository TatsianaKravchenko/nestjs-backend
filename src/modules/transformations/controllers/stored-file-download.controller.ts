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
  TRANSFORMATIONS_DOWNLOAD_ACTION,
  TRANSFORMATIONS_PERMISSION,
} from '@/modules/rbac/rbac.constants';
import { RequirePermission } from '@/modules/rbac/rbac.decorators';
import type { RbacRequest } from '@/modules/rbac/rbac.types';

import {
  type DownloadResult,
  StoredFileDownloadService,
} from '../services/stored-file-download.service';
import { problem } from './transformation-history.controller';

/** Streams a stored file as a private, non-cacheable attachment. */
export function sendStoredFile(
  reply: FastifyReply,
  file: DownloadResult,
): void {
  void reply
    .status(200)
    .header('content-type', file.contentType)
    .header('content-length', file.size)
    .header(
      'content-disposition',
      `attachment; filename="converted.${file.extension}"`,
    )
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'no-store')
    .send(file.stream);
}

/**
 * Check order: AccessTokenGuard (JWT + active user, 401) -> CsrfGuard ->
 * RbacGuard `transformations@download` (403) -> handler. The guards run before
 * anything is read; the item is then looked up by its id AND the session user,
 * so another user's item is a 404, never a 403.
 */
@ApiTags('transformations')
@ApiCookieAuth('access_token')
@ApiParam({ name: 'itemId', format: 'uuid' })
@problem(401, 'Missing, invalid or expired session, or user is not active.')
@problem(403, 'Missing transformations@download.')
@problem(
  404,
  'No such item, not yours, not saved, failed, or the file has expired.',
)
@problem(409, 'file_not_ready: the file is still being stored.')
@problem(503, 'Database or storage unavailable.')
@Controller('transformations/history')
@RequirePermission(TRANSFORMATIONS_PERMISSION, TRANSFORMATIONS_DOWNLOAD_ACTION)
export class StoredFileDownloadController {
  constructor(private readonly downloads: StoredFileDownloadService) {}

  @Get(':itemId/download')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Download the saved result of one own history item',
    description:
      'Only items converted with `save=true` and already stored. The file is ' +
      'streamed as `converted.<ext>`; there is no public link.',
  })
  @ApiOkResponse({
    description: 'The stored file.',
    content: { 'application/octet-stream': {} },
  })
  async download(
    @Param('itemId') itemId: string,
    @Req() request: RbacRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const file = await this.downloads.open(
      {
        requestId: String(request.id),
        // Set by AccessTokenGuard from the JWT `sub`; the guards guarantee it.
        actorUserId: request.user?.id ?? '',
      },
      itemId,
    );
    sendStoredFile(reply, file);
  }
}
