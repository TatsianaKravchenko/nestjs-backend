import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { trimLower } from './register.dto';

export class LoginDto {
  @ApiProperty({
    example: 'user@example.com',
    description: 'Trimmed and lowercased before use.',
  })
  @Transform(trimLower)
  @IsEmail()
  @MaxLength(320)
  email!: string;

  /** Sent as typed: whitespace is significant and nothing is normalized. */
  @ApiProperty({ example: 'Passw0rd-example', maxLength: 128 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;
}
