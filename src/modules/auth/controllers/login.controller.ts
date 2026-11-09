import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { RequestContext } from '../services/auth-audit.service';
import { REFRESH_COOKIE } from '../constants/auth.constants';
import { CookieService } from '../services/cookie.service';
import { CsrfGuard } from '../guards/csrf.guard';
import { PROBLEM_DETAILS_SCHEMA } from '../errors/auth.errors';
import { ConfirmLoginDto } from '../dto/confirm-login.dto';
import { LoginDto } from '../dto/login.dto';
import { ResendLoginDto } from '../dto/resend-login.dto';
import {
  ChallengeResponse,
  LoginService,
  ResendResponse,
} from '../services/login.service';
import { SessionService } from '../services/session.service';

const challengeExample = {
  confirmationRequired: true,
  method: 'otp',
  attemptId: 'uuid',
  expiresInSeconds: 600,
  resendAfterSeconds: 60,
};
const problemContent = {
  'application/problem+json': { schema: PROBLEM_DETAILS_SCHEMA },
};

const context = (request: FastifyRequest): RequestContext => ({
  ip: request.ip,
  requestId: String(request.id),
});

/**
 * Login, refresh and logout. Only the throttler named for each route applies
 * (`login` or `refresh`); the CSRF check runs first for every request.
 */
@ApiTags('auth')
@ApiResponse({
  status: 403,
  description: 'CSRF request rejected.',
  content: problemContent,
})
@Controller('auth')
@UseGuards(CsrfGuard, ThrottlerGuard)
@SkipThrottle({ default: true, registration: true })
export class LoginController {
  constructor(
    private readonly login: LoginService,
    private readonly session: SessionService,
    private readonly cookies: CookieService,
  ) {}

  @Post('login')
  @SkipThrottle({ refresh: true })
  @ApiOperation({
    summary: 'Log in with email and password',
    description:
      'Sets the access_token and refresh_token HttpOnly cookies (204), or starts an email challenge (202).',
  })
  @ApiNoContentResponse({ description: 'Signed in: both cookies are set.' })
  @ApiAcceptedResponse({
    description: 'Email confirmation required.',
    schema: { example: challengeExample },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid email or password format.',
    content: problemContent,
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid credentials.',
    content: problemContent,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit, or a new email was requested within 60 seconds.',
    content: problemContent,
  })
  @ApiResponse({
    status: 503,
    description: 'Database, SMTP or token signing is unavailable.',
    content: problemContent,
  })
  async signIn(
    @Body() dto: LoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ChallengeResponse | undefined> {
    const result = await this.login.login(dto, context(request));
    if (result.kind === 'tokens') {
      this.cookies.issue(reply, result.tokens);
      void reply.status(HttpStatus.NO_CONTENT);
      return undefined;
    }
    void reply.status(HttpStatus.ACCEPTED);
    return result.body;
  }

  @Post('login/confirm')
  @SkipThrottle({ login: true, refresh: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Confirm a login with the emailed code or link token',
    description: 'OTP: attemptId + code. Magic link: token (attemptId.secret).',
  })
  @ApiNoContentResponse({ description: 'Signed in: both cookies are set.' })
  @ApiResponse({
    status: 400,
    description: 'Wrong, expired or used secret.',
    content: problemContent,
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid credentials.',
    content: problemContent,
  })
  @ApiResponse({
    status: 429,
    description: 'OTP attempts exhausted.',
    content: problemContent,
  })
  @ApiResponse({
    status: 503,
    description: 'Service unavailable.',
    content: problemContent,
  })
  async confirm(
    @Body() dto: ConfirmLoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const tokens = await this.login.confirm(dto, context(request));
    this.cookies.issue(reply, tokens);
  }

  //send code or link one more time
  @Post('login/resend')
  @SkipThrottle({ login: true, refresh: true })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Send a new code or link (once per 60 seconds)' })
  @ApiAcceptedResponse({
    schema: {
      example: {
        method: 'otp',
        attemptId: 'uuid',
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Nothing to resend.',
    content: problemContent,
  })
  @ApiResponse({
    status: 429,
    description: 'Resend too early.',
    content: problemContent,
  })
  @ApiResponse({
    status: 503,
    description: 'Email could not be sent.',
    content: problemContent,
  })
  resend(
    @Body() dto: ResendLoginDto,
    @Req() request: FastifyRequest,
  ): Promise<ResendResponse> {
    return this.login.resend(dto, context(request));
  }

  @Post('refresh')
  @SkipThrottle({ login: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Rotate the token pair',
    description: 'Reads the refresh_token cookie only. No body.',
  })
  @ApiNoContentResponse({ description: 'New cookies are set.' })
  @ApiResponse({
    status: 401,
    description: 'Invalid session.',
    content: problemContent,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded.',
    content: problemContent,
  })
  @ApiResponse({
    status: 503,
    description: 'Service unavailable.',
    content: problemContent,
  })
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const tokens = await this.session.refresh(
      this.cookies.read(request, REFRESH_COOKIE),
      context(request),
    );
    this.cookies.issue(reply, tokens);
  }

  @Post('logout')
  @SkipThrottle({ login: true, refresh: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Clear the auth cookies',
    description:
      'Always 204, with or without valid cookies. Tokens are not revoked on the server.',
  })
  @ApiNoContentResponse({ description: 'Cookies cleared.' })
  logout(@Res({ passthrough: true }) reply: FastifyReply): void {
    this.cookies.clear(reply);
  }
}
