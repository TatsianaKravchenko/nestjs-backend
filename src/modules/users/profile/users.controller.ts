import {
  Controller,
  Get,
  Param,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { PROBLEM_DETAILS_SCHEMA } from '@/modules/auth/errors/auth.errors';
import { RequirePermission } from '@/modules/rbac/rbac.decorators';
import {
  USERS_PERMISSION,
  USERS_READ_ACTION,
} from '@/modules/rbac/rbac.constants';
import type { RbacRequest } from '@/modules/rbac/rbac.types';

import { UserProfileDto } from '../dto/user-profile.dto';
import { ProfileAccessGuard } from './profile-access.guard';
import { UserIdFormatGuard } from './user-id-format.guard';
import { ReadContext, UserProfileService } from './user-profile.service';

const problem = (status: number, description: string) =>
  ApiResponse({
    status,
    description,
    content: { 'application/problem+json': { schema: PROBLEM_DETAILS_SCHEMA } },
  });

const context = (request: RbacRequest, targetUserId: string): ReadContext => ({
  requestId: String(request.id),
  // Set by AccessTokenGuard; the guards guarantee it is present here.
  actorUserId: request.user?.id ?? '',
  targetUserId,
});

/**
 * Check order: `UserIdFormatGuard` (400) -> AccessTokenGuard (JWT + active
 * user, 401) -> CsrfGuard -> RbacGuard `users@read` (403) -> ProfileAccessGuard
 * (`users@read_any` for a foreign id, 403; rate limit, 429) -> handler (target
 * lookup, 404, safe projection). Guards run in declaration order, class-level
 * before method-level; decorators apply bottom-up, so `UseGuards` sits below
 * `RequirePermission` to run first.
 */
@ApiTags('users')
@ApiCookieAuth('access_token')
@ApiParam({
  name: 'userId',
  description: '1-128 characters: letters, digits, `_`, `-`.',
  example: '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44',
})
@problem(400, 'Malformed userId.')
@problem(401, 'Missing, invalid or expired session, or user is not active.')
@problem(403, 'Missing users@read, or users@read_any for a foreign id.')
@problem(429, 'Rate limit exceeded (120/min own, 60/min foreign).')
@problem(503, 'User database, policy snapshot or photo storage unavailable.')
@Controller('users')
@RequirePermission(USERS_PERMISSION, USERS_READ_ACTION)
@UseGuards(UserIdFormatGuard)
export class UsersController {
  constructor(private readonly profiles: UserProfileService) {}

  @Get(':userId')
  @UseGuards(ProfileAccessGuard)
  @ApiOperation({
    summary: 'Get a user profile',
    description:
      'Own profile needs users@read; another user needs users@read_any too. ' +
      'The shape is the same for self, foreign and admin views.',
  })
  @ApiOkResponse({ type: UserProfileDto })
  @problem(404, 'User not found.')
  getProfile(
    @Param('userId') userId: string,
    @Req() request: RbacRequest,
  ): Promise<UserProfileDto> {
    return this.profiles.getProfile(context(request, userId));
  }

  @Get(':userId/photo')
  @UseGuards(ProfileAccessGuard)
  @ApiOperation({
    summary: 'Stream the protected profile photo',
    description:
      'Same checks as the profile. WebP bytes, streamed from storage.',
  })
  @ApiProduces('image/webp')
  @ApiOkResponse({
    description: 'WebP image.',
    content: { 'image/webp': { schema: { type: 'string', format: 'binary' } } },
  })
  @problem(404, 'User, photo not found, or user is deleting/deleted.')
  async getPhoto(
    @Param('userId') userId: string,
    @Req() request: RbacRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    const stream = await this.profiles.getPhoto(context(request, userId));
    void reply.header('X-Content-Type-Options', 'nosniff');
    void reply.header('Cache-Control', 'private, max-age=300');
    return new StreamableFile(stream, { type: 'image/webp' });
  }
}
