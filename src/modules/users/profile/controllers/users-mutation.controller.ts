import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpException,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import {
  ApiErrorCode,
  invalidRequest,
  payloadTooLarge,
  PROBLEM_DETAILS_SCHEMA,
  unsupportedMediaType,
} from '@/modules/auth/errors/auth.errors';
import { RequirePermission } from '@/modules/rbac/rbac.decorators';
import {
  USERS_PERMISSION,
  USERS_UPDATE_ACTION,
} from '@/modules/rbac/rbac.constants';
import type { RbacRequest } from '@/modules/rbac/rbac.types';

import { UserProfileDto } from '../../dto/user-profile.dto';
import {
  ConfirmEmailChangeDto,
  ResendEmailChangeDto,
  StartEmailChangeDto,
  UPDATE_USER_FIELDS,
  UpdateUserDto,
} from '../dto/update-user.dto';
import {
  EmailChangeAccepted,
  EmailChangeService,
} from '../services/email-change.service';
import { MutationAccessGuard, SelfOnly } from '../guards/mutation-access.guard';
import { StrictBodyPipe } from '../pipes/strict-body.pipe';
import { UserIdFormatGuard } from '../guards/user-id-format.guard';
import { UploadedFile, UserPhotoService } from '../services/user-photo.service';
import { UserUpdateService } from '../services/user-update.service';
import type { MutationContext } from '../utils/profile-support';

const problem = (status: number, description: string) =>
  ApiResponse({
    status,
    description,
    content: { 'application/problem+json': { schema: PROBLEM_DETAILS_SCHEMA } },
  });

const context = (
  request: RbacRequest,
  targetUserId: string,
): MutationContext => ({
  requestId: String(request.id),
  // Set by AccessTokenGuard; the guards guarantee it is present here.
  actorUserId: request.user?.id ?? '',
  targetUserId,
});

const MULTIPART_CODES_400 = new Set([
  'FST_FILES_LIMIT',
  'FST_FIELDS_LIMIT',
  'FST_PARTS_LIMIT',
  'FST_INVALID_MULTIPART_CONTENT_TYPE',
]);

/** Exactly one `file` part; anything else is a 400, a too large file a 413. */
async function readSingleFile(request: FastifyRequest): Promise<UploadedFile> {
  if (!request.isMultipart()) {
    throw unsupportedMediaType('Content-Type must be multipart/form-data');
  }
  let file: UploadedFile | undefined;
  try {
    for await (const part of request.parts()) {
      if (part.type !== 'file' || part.fieldname !== 'file' || file) {
        throw invalidRequest('Send exactly one file field named "file"');
      }
      file = { data: await part.toBuffer(), mimetype: part.mimetype };
    }
  } catch (error) {
    if (error instanceof HttpException) throw error;
    const code = (error as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      throw payloadTooLarge('The file exceeds 5 MiB');
    }
    throw invalidRequest(
      MULTIPART_CODES_400.has(code ?? '')
        ? 'Send exactly one file field named "file"'
        : 'Malformed multipart body',
      ApiErrorCode.InvalidRequest,
    );
  }
  if (!file) throw invalidRequest('The file field is missing');
  return file;
}

/**
 * Check order: `UserIdFormatGuard` (400) -> AccessTokenGuard (401) -> CsrfGuard
 * -> RbacGuard `users@update` (403) -> `MutationAccessGuard` (`users@update_any`
 * for a foreign id, 403; mutation rate limit, 429) -> body validation (400) ->
 * handler (body-dependent permission, target lookup 404, state 409).
 * The bodies are parsed by `StrictBodyPipe`: the parameter is typed `unknown`
 * so the global stripping pipe does not hide unknown fields.
 */
@ApiTags('users')
@ApiCookieAuth('access_token')
@ApiParam({
  name: 'userId',
  description: '1-128 characters: letters, digits, `_`, `-`.',
  example: '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44',
})
@problem(400, 'Malformed userId or body.')
@problem(401, 'Missing, invalid or expired session, or user is not active.')
@problem(403, 'Missing users@update, users@update_any, or CSRF check failed.')
@problem(429, 'Rate limit exceeded.')
@problem(503, 'Database, policy, SMTP or storage unavailable.')
@Controller('users')
@RequirePermission(USERS_PERMISSION, USERS_UPDATE_ACTION)
@UseGuards(UserIdFormatGuard)
export class UsersMutationController {
  constructor(
    private readonly updates: UserUpdateService,
    private readonly emailChange: EmailChangeService,
    private readonly photos: UserPhotoService,
  ) {}

  @Patch(':userId')
  @UseGuards(MutationAccessGuard)
  @ApiOperation({
    summary: 'Update a user profile',
    description:
      'One to three of displayName, email, status. Self may send displayName only; ' +
      'email and status need users@update_any (also for the own user). ' +
      'Unknown fields, repeated keys and an empty body are 400.',
  })
  @ApiBody({ type: UpdateUserDto })
  @ApiOkResponse({ type: UserProfileDto })
  @problem(404, 'User not found (only after the permission checks).')
  @problem(
    409,
    'Email in use; target is pending/deleting/deleted; or the last active rbac@manage user would be blocked.',
  )
  update(
    @Param('userId') userId: string,
    @Body(new StrictBodyPipe(UpdateUserDto, UPDATE_USER_FIELDS))
    body: unknown,
    @Req() request: RbacRequest,
  ): Promise<UserProfileDto> {
    return this.updates.update(context(request, userId), body as UpdateUserDto);
  }

  @Post(':userId/email-change')
  @HttpCode(202)
  @SelfOnly()
  @UseGuards(MutationAccessGuard)
  @ApiOperation({
    summary: 'Start an email change',
    description:
      'Sends an OTP or magic link (server setting) to the new address. Own user only.',
  })
  @ApiBody({ type: StartEmailChangeDto })
  @ApiAcceptedResponse({ description: 'Challenge created and sent.' })
  @problem(409, 'The new email equals the current one or is in use.')
  @problem(429, 'Resend pause (60 s) or 5 emails per hour exceeded.')
  @problem(
    503,
    'SMTP failed after commit: body has confirmationRequired, method, challengeId, retryAfterSeconds (no secret).',
  )
  startEmailChange(
    @Param('userId') userId: string,
    @Body(new StrictBodyPipe(StartEmailChangeDto, ['newEmail']))
    body: unknown,
    @Req() request: RbacRequest,
  ): Promise<EmailChangeAccepted> {
    return this.emailChange.start(
      { requestId: String(request.id), userId },
      body as StartEmailChangeDto,
    );
  }

  @Post(':userId/email-change/resend')
  @HttpCode(202)
  @SelfOnly()
  @UseGuards(MutationAccessGuard)
  @ApiOperation({ summary: 'Resend the email change secret' })
  @ApiBody({ type: ResendEmailChangeDto })
  @ApiAcceptedResponse({ description: 'New secret sent; the old one is void.' })
  @problem(409, 'Challenge cancelled by an admin or by an email conflict.')
  @problem(429, 'Resend pause, hourly limit, or attempts exhausted.')
  resendEmailChange(
    @Param('userId') userId: string,
    @Body(new StrictBodyPipe(ResendEmailChangeDto, ['challengeId']))
    body: unknown,
    @Req() request: RbacRequest,
  ): Promise<EmailChangeAccepted> {
    return this.emailChange.resend(
      { requestId: String(request.id), userId },
      body as ResendEmailChangeDto,
    );
  }

  @Post(':userId/email-change/confirm')
  @HttpCode(200)
  @SelfOnly()
  @UseGuards(MutationAccessGuard)
  @ApiOperation({
    summary: 'Confirm an email change',
    description:
      'Needs the active session of the same user and either {challengeId, code} or {token}.',
  })
  @ApiBody({ type: ConfirmEmailChangeDto })
  @ApiOkResponse({ type: UserProfileDto })
  @problem(409, 'Email taken meanwhile, or challenge cancelled.')
  @problem(429, 'Five wrong codes: request a new code.')
  confirmEmailChange(
    @Param('userId') userId: string,
    @Body(
      new StrictBodyPipe(ConfirmEmailChangeDto, [
        'challengeId',
        'code',
        'token',
      ]),
    )
    body: unknown,
    @Req() request: RbacRequest,
  ): Promise<UserProfileDto> {
    return this.emailChange.confirm(
      { requestId: String(request.id), userId },
      body as ConfirmEmailChangeDto,
    );
  }

  @Put(':userId/photo')
  @UseGuards(MutationAccessGuard)
  @ApiOperation({
    summary: 'Replace the profile photo',
    description:
      'One `file` field, JPEG/PNG/WebP, up to 5 MiB, 64-4096 px, not animated. ' +
      'Stored as one WebP (max 1024x1024, no metadata).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOkResponse({ type: UserProfileDto })
  @problem(404, 'User not found.')
  @problem(409, 'Target is pending, deleting or deleted.')
  @problem(413, 'File larger than 5 MiB.')
  @problem(415, 'Not JPEG, PNG or WebP, or MIME does not match the content.')
  async putPhoto(
    @Param('userId') userId: string,
    @Req() request: RbacRequest,
  ): Promise<UserProfileDto> {
    const file = await readSingleFile(request);
    return this.photos.replace(context(request, userId), file);
  }

  @Delete(':userId/photo')
  @HttpCode(204)
  @UseGuards(MutationAccessGuard)
  @ApiOperation({ summary: 'Remove the profile photo' })
  @ApiNoContentResponse({ description: 'Removed, or there was none.' })
  @problem(404, 'User not found.')
  @problem(409, 'Target is pending, deleting or deleted.')
  async deletePhoto(
    @Param('userId') userId: string,
    @Req() request: RbacRequest,
  ): Promise<void> {
    await this.photos.clear(context(request, userId));
  }
}
