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
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';

import { ConfirmRegistrationDto } from './dto/confirm-registration.dto';
import { RegisterDto } from './dto/register.dto';
import { ResendRegistrationDto } from './dto/resend-registration.dto';
import {
  ConfirmationRequiredResponse,
  RegisteredUserResponse,
  RegisterResult,
  RegistrationService,
} from './registration.service';

/**
 * Only the dedicated "registration" throttler (configurable limits) applies
 * to these routes, not the global default one.
 */
@ApiTags('auth')
@ApiTooManyRequestsResponse({ description: 'Rate limit exceeded.' })
@Controller('auth')
@UseGuards(ThrottlerGuard)
@SkipThrottle({ default: true })
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
  @ApiBadRequestResponse({ description: 'Invalid email or password.' })
  @ApiConflictResponse({ description: 'Email is already registered.' })
  @ApiServiceUnavailableResponse({ description: 'Email could not be sent.' })
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
  @ApiBadRequestResponse({ description: 'Wrong, expired or used code/token.' })
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
  @ApiBadRequestResponse({ description: 'Nothing to resend for this email.' })
  @ApiServiceUnavailableResponse({ description: 'Email could not be sent.' })
  @HttpCode(HttpStatus.ACCEPTED)
  resend(
    @Body() dto: ResendRegistrationDto,
  ): Promise<ConfirmationRequiredResponse> {
    return this.registration.resend(dto);
  }
}
