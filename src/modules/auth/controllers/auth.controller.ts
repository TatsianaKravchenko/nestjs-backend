import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';

import { PROBLEM_DETAILS_SCHEMA } from '../errors/auth.errors';
import { ConfirmRegistrationDto } from '../dto/confirm-registration.dto';
import { RegisterDto } from '../dto/register.dto';
import { ResendRegistrationDto } from '../dto/resend-registration.dto';
import {
  ConfirmationRequiredResponse,
  RegisteredUserResponse,
  RegisterResult,
  RegistrationService,
} from '../services/registration.service';

const problemContent = {
  'application/problem+json': { schema: PROBLEM_DETAILS_SCHEMA },
};

/**
 * Only the dedicated "registration" throttler (configurable limits) applies
 * to these routes, not the global default or the login/refresh ones.
 */
@ApiTags('auth')
@ApiResponse({
  status: 429,
  description: 'Rate limit exceeded.',
  content: problemContent,
})
@Controller('auth')
@UseGuards(ThrottlerGuard)
@SkipThrottle({ default: true, login: true, refresh: true })
export class AuthController {
  constructor(private readonly registration: RegistrationService) {}

  @Post('register')
  @ApiOperation({ summary: 'Register a new user' })
  @ApiCreatedResponse({
    description: 'Confirmation disabled: user is active.',
    schema: {
      example: { id: 'uuid', email: 'user@example.com', status: 'active' },
    },
  })
  @ApiAcceptedResponse({
    description: 'Confirmation enabled: a code or link was emailed.',
    schema: {
      example: {
        confirmationRequired: true,
        method: 'otp',
        attemptId: 'uuid',
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid email or password.',
    content: problemContent,
  })
  @ApiResponse({
    status: 409,
    description: 'Email is already registered.',
    content: problemContent,
  })
  @ApiResponse({
    status: 503,
    description: 'Email could not be sent.',
    content: problemContent,
  })
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<RegisterResult['body']> {
    const result = await this.registration.register(dto);
    void res.status(result.statusCode);
    return result.body;
  }

  @Post('register/confirm')
  @ApiOperation({
    summary: 'Confirm registration',
    description: 'Send attemptId + code (OTP) or token (magic link).',
  })
  @ApiOkResponse({
    schema: {
      example: { id: 'uuid', email: 'user@example.com', status: 'active' },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Wrong, expired or used code/token.',
    content: problemContent,
  })
  @HttpCode(HttpStatus.OK)
  confirm(
    @Body() dto: ConfirmRegistrationDto,
  ): Promise<RegisteredUserResponse> {
    return this.registration.confirm(dto);
  }

  @Post('register/resend')
  @ApiOperation({ summary: 'Resend the confirmation email (once per 60s)' })
  @ApiAcceptedResponse({
    schema: {
      example: {
        confirmationRequired: true,
        method: 'otp',
        attemptId: 'uuid',
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Nothing to resend for this email.',
    content: problemContent,
  })
  @ApiResponse({
    status: 503,
    description: 'Email could not be sent.',
    content: problemContent,
  })
  @HttpCode(HttpStatus.ACCEPTED)
  resend(
    @Body() dto: ResendRegistrationDto,
  ): Promise<ConfirmationRequiredResponse> {
    return this.registration.resend(dto);
  }
}
