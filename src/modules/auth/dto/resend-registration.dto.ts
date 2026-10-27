import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

import { trimLower } from './register.dto';

export class ResendRegistrationDto {
  @ApiProperty({ example: 'user@example.com' })
  @Transform(trimLower)
  @IsEmail()
  @MaxLength(320)
  email!: string;
}
