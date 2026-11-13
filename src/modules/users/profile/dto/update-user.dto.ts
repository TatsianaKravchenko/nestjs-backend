import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';

import { trimLower } from '@/modules/auth/dto/register.dto';

import { UserStatus } from '../../entities/user.entity';

export const UPDATE_USER_FIELDS = ['displayName', 'email', 'status'] as const;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Trim Unicode whitespace, then NFC. Non-strings pass to the validators. */
export const normalizeDisplayName = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim().normalize('NFC') : value;

function IsDisplayName(options?: ValidationOptions) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'isDisplayName',
      target: target.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string') return false;
          const length = [...value].length;
          return length >= 1 && length <= 80 && !CONTROL.test(value);
        },
        defaultMessage: () =>
          'displayName must be 1-80 characters without control characters',
      },
    });
}

export class UpdateUserDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 80,
    description: 'Trimmed, NFC. `null` clears it.',
  })
  @Transform(({ value }) => normalizeDisplayName(value))
  @ValidateIf(
    (o: UpdateUserDto) => o.displayName !== null && o.displayName !== undefined,
  )
  @IsDisplayName()
  displayName?: string | null;

  @ApiPropertyOptional({
    description: 'Requires users@update_any, also for the own user.',
  })
  @Transform(trimLower)
  @ValidateIf((o: UpdateUserDto) => o.email !== undefined)
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({
    enum: [UserStatus.ACTIVE, UserStatus.BLOCKED],
    description: 'Requires users@update_any.',
  })
  @ValidateIf((o: UpdateUserDto) => o.status !== undefined)
  @IsIn([UserStatus.ACTIVE, UserStatus.BLOCKED])
  status?: UserStatus.ACTIVE | UserStatus.BLOCKED;
}

export class StartEmailChangeDto {
  @ApiProperty({ description: 'Trimmed and lowercased.' })
  @Transform(trimLower)
  @IsEmail()
  @MaxLength(254)
  newEmail!: string;
}

export class ResendEmailChangeDto {
  @ApiProperty()
  @IsString()
  @Matches(/^[0-9a-f-]{36}$/i)
  challengeId!: string;
}

export class ConfirmEmailChangeDto {
  @ApiPropertyOptional({ description: 'OTP only.' })
  @ValidateIf((o: ConfirmEmailChangeDto) => o.challengeId !== undefined)
  @Matches(/^[0-9a-f-]{36}$/i)
  challengeId?: string;

  @ApiPropertyOptional({ example: '123456', description: 'OTP only.' })
  @ValidateIf((o: ConfirmEmailChangeDto) => o.code !== undefined)
  @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits' })
  code?: string;

  @ApiPropertyOptional({
    description: 'Magic link only: challengeId.secret from the link fragment.',
  })
  @ValidateIf((o: ConfirmEmailChangeDto) => o.token !== undefined)
  @IsString()
  @MaxLength(200)
  token?: string;
}
