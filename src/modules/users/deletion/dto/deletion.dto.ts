import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

import { DeletionJobStatus } from '../entities/deletion-job.entity';

export const RESEND_DELETION_FIELDS = ['challengeId'] as const;
export const CONFIRM_DELETION_FIELDS = [
  'challengeId',
  'code',
  'token',
] as const;

export class ResendDeletionDto {
  @ApiProperty()
  @IsString()
  @Matches(/^[0-9a-f-]{36}$/i)
  challengeId!: string;
}

export class ConfirmDeletionDto {
  @ApiPropertyOptional({ description: 'OTP only.' })
  @ValidateIf((o: ConfirmDeletionDto) => o.challengeId !== undefined)
  @Matches(/^[0-9a-f-]{36}$/i)
  challengeId?: string;

  @ApiPropertyOptional({ example: '123456', description: 'OTP only.' })
  @ValidateIf((o: ConfirmDeletionDto) => o.code !== undefined)
  @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits' })
  code?: string;

  @ApiPropertyOptional({
    description: 'Magic link only: challengeId.secret from the link fragment.',
  })
  @ValidateIf((o: ConfirmDeletionDto) => o.token !== undefined)
  @IsString()
  @MaxLength(200)
  token?: string;
}

export class DeletionChallengeAcceptedDto {
  @ApiProperty({ example: true })
  confirmationRequired!: true;

  @ApiProperty({ enum: ['otp', 'magic_link'] })
  method!: string;

  @ApiProperty({ format: 'uuid' })
  challengeId!: string;

  @ApiProperty({ example: 600 })
  expiresInSeconds!: number;

  @ApiProperty({ example: 60 })
  resendAfterSeconds!: number;
}

export class DeletionAcceptedDto {
  @ApiProperty({
    example: '3f2b9c1e6a1d4c579a3f0d2f7b1c8e44',
    description:
      '32 lowercase hex characters. Keep it: it is the status receipt.',
  })
  jobId!: string;

  @ApiProperty({
    example: '/users/3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44/deletion-status',
    description: 'A path only: the receipt is sent in `Deletion-Receipt`.',
  })
  statusUrl!: string;

  @ApiProperty({ enum: DeletionJobStatus })
  status!: DeletionJobStatus;
}

export class DeletionStatusDto {
  @ApiProperty({ enum: DeletionJobStatus })
  status!: DeletionJobStatus;
}
