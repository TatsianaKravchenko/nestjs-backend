import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export const trimLower = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RegisterDto {
  @ApiProperty({
    example: 'user@example.com',
    description: 'Trimmed and lowercased before use.',
  })
  @Transform(trimLower)
  @IsEmail()
  @MaxLength(320)
  email!: string;

  /** Outer whitespace is significant and kept. At least one letter (any alphabet) and one digit. */
  @ApiProperty({
    example: 'Passw0rd-example',
    minLength: 8,
    maxLength: 128,
    description: 'At least one letter and one digit. Outer spaces are kept.',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/\p{L}/u, { message: 'password must contain at least one letter' })
  @Matches(/\p{Nd}/u, { message: 'password must contain at least one digit' })
  password!: string;
}
