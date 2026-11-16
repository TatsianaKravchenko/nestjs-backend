import {
  Body,
  Controller,
  Delete,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import {
  invalidRequest,
  PROBLEM_DETAILS_SCHEMA,
} from '@/modules/auth/errors/auth.errors';
import { CookieService } from '@/modules/auth/services/cookie.service';
import type { RbacRequest } from '@/modules/rbac/rbac.types';

import { StrictBodyPipe } from '../../profile/pipes/strict-body.pipe';
import { UserIdFormatGuard } from '../../profile/guards/user-id-format.guard';
import {
  CONFIRM_DELETION_FIELDS,
  ConfirmDeletionDto,
  DeletionAcceptedDto,
  DeletionChallengeAcceptedDto,
  RESEND_DELETION_FIELDS,
  ResendDeletionDto,
} from '../dto/deletion.dto';
import { JOB_ID_PATTERN } from '../entities/deletion-job.entity';
import { DeletionRoute } from '../guards/deletion-access.guard';
import {
  DeletionChallengeAccepted,
  DeletionChallengeService,
} from '../services/deletion-challenge.service';
import { DeletionRequestService } from '../services/deletion-request.service';
import {
  type DeletionAccepted,
  IDEMPOTENCY_HEADER,
} from '../utils/deletion-support';

const problem = (status: number, description: string) =>
  ApiResponse({
    status,
    description,
    content: { 'application/problem+json': { schema: PROBLEM_DETAILS_SCHEMA } },
  });

/**
 * Check order: `UserIdFormatGuard` (400) -> AccessTokenGuard (401) -> CsrfGuard
 * -> RbacGuard `users@delete` (403) -> `DeletionAccessGuard` (scope, 403) ->
 * body validation (400) -> handler (challenge 400/429, target 404, state 409).
 * Deleting the own account takes the email challenge; `DELETE` is for
 * administrators and refuses the own id.
 */
@ApiTags('users')
@ApiCookieAuth('access_token')
@ApiParam({
  name: 'userId',
  description: '1-128 characters: letters, digits, `_`, `-`.',
  example: '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44',
})
@problem(400, 'Malformed userId, body or Idempotency-Key.')
@problem(401, 'Missing, invalid or expired session, or user is not active.')
@problem(
  403,
  'Missing users@delete or users@delete_any, CSRF failed, a foreign id on a self route, or the own id on DELETE (self_confirmation_required).',
)
@problem(429, 'Rate limit exceeded.')
@problem(503, 'Database, policy or SMTP unavailable.')
@Controller('users')
@UseGuards(UserIdFormatGuard)
export class DeletionController {
  constructor(
    private readonly challenges: DeletionChallengeService,
    private readonly requests: DeletionRequestService,
    private readonly cookies: CookieService,
  ) {}

  @Post(':userId/deletion-challenge')
  @HttpCode(202)
  @DeletionRoute('self')
  @ApiOperation({
    summary: 'Start the deletion of the own account',
    description:
      'Sends an OTP or magic link (server setting) to the current email. Own user only.',
  })
  @ApiAcceptedResponse({ type: DeletionChallengeAcceptedDto })
  @problem(429, 'Resend pause (60 s) or 5 emails per hour exceeded.')
  @problem(
    503,
    'SMTP failed after commit: body has confirmationRequired, method, challengeId, retryAfterSeconds (no secret).',
  )
  startChallenge(
    @Param('userId') userId: string,
    @Req() request: RbacRequest,
  ): Promise<DeletionChallengeAccepted> {
    return this.challenges.start({ requestId: String(request.id), userId });
  }

  @Post(':userId/deletion-challenge/resend')
  @HttpCode(202)
  @DeletionRoute('self')
  @ApiOperation({ summary: 'Resend the deletion secret' })
  @ApiBody({ type: ResendDeletionDto })
  @ApiAcceptedResponse({ type: DeletionChallengeAcceptedDto })
  @problem(400, 'Unknown, consumed or foreign challenge.')
  @problem(429, 'Resend pause, hourly limit, or attempts exhausted.')
  resendChallenge(
    @Param('userId') userId: string,
    @Body(new StrictBodyPipe(ResendDeletionDto, RESEND_DELETION_FIELDS))
    body: unknown,
    @Req() request: RbacRequest,
  ): Promise<DeletionChallengeAccepted> {
    return this.challenges.resend(
      { requestId: String(request.id), userId },
      body as ResendDeletionDto,
    );
  }

  @Post(':userId/deletion-confirm')
  @HttpCode(202)
  @DeletionRoute('self')
  @ApiOperation({
    summary: 'Confirm the deletion of the own account',
    description:
      'Needs {challengeId, code} or {token} and an Idempotency-Key (32 lowercase hex), ' +
      'which becomes the job id. The user is `deleting` at once and the cookies are expired. ' +
      'Keep the key: it is the Deletion-Receipt for the status route.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '32 lowercase hex characters.',
  })
  @ApiBody({ type: ConfirmDeletionDto })
  @ApiAcceptedResponse({ type: DeletionAcceptedDto })
  @problem(400, 'Invalid, expired or consumed confirmation (5th wrong code).')
  @problem(
    409,
    'The Idempotency-Key belongs to another user, or the last active rbac@manage user would be removed.',
  )
  @problem(429, 'Five wrong codes: request a new code.')
  async confirm(
    @Param('userId') userId: string,
    @Headers(IDEMPOTENCY_HEADER) key: unknown,
    @Body(new StrictBodyPipe(ConfirmDeletionDto, CONFIRM_DELETION_FIELDS))
    body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DeletionAccepted> {
    if (typeof key !== 'string' || !JOB_ID_PATTERN.test(key)) {
      throw invalidRequest(
        'Idempotency-Key must be 32 lowercase hex characters',
      );
    }
    const result = await this.requests.confirm(
      { userId, jobId: key },
      body as ConfirmDeletionDto,
    );
    this.cookies.clear(reply);
    return result;
  }

  @Delete(':userId')
  @HttpCode(202)
  @DeletionRoute('admin')
  @ApiOperation({
    summary: 'Delete a user (administrator)',
    description:
      'Needs users@delete and users@delete_any. Works for pending, active and blocked users. The own id is refused: use the confirmation flow. ' +
      'Repeating the call returns the same job; a failed job is queued again.',
  })
  @ApiAcceptedResponse({ type: DeletionAcceptedDto })
  @problem(404, 'User not found (only after the permission checks).')
  @problem(409, 'The last active rbac@manage user would be removed.')
  @problem(
    503,
    'Database or policy unavailable, or the target is deleting/deleted without a job (inconsistent state).',
  )
  remove(@Param('userId') userId: string): Promise<DeletionAccepted> {
    return this.requests.deleteByAdmin(userId);
  }
}
