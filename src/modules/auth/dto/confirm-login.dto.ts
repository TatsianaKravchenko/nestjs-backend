import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * OTP: `attemptId` + `code`. Magic link: `token` (`attemptId.secret`).
 * The combination is checked by the service, which answers a generic 400.
 */
export class ConfirmLoginDto {
  @ApiPropertyOptional({ description: 'OTP only.' })
  @IsOptional()
  @IsUUID()
  attemptId?: string;

  @ApiPropertyOptional({ example: '123456', description: 'OTP only.' })
  @IsOptional()
  @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits' })
  code?: string;

  @ApiPropertyOptional({
    description: 'Magic link only: attemptId.secret from the link fragment.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  token?: string;
}
