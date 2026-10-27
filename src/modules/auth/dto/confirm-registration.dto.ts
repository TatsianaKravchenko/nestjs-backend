import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Matches } from 'class-validator';

/**
 * OTP flow: `attemptId` + `code`. Magic-link flow: `token`.
 * A wrong combination is answered with the same generic 400 as a wrong code.
 */
export class ConfirmRegistrationDto {
  @ApiPropertyOptional({
    description: 'OTP flow: id returned by register/resend.',
  })
  @IsOptional()
  @IsUUID()
  attemptId?: string;

  @IsOptional()
  @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits' })
  code?: string;

  @ApiPropertyOptional({ description: 'Magic-link flow: token from the link.' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/, { message: 'token is invalid' })
  token?: string;
}
