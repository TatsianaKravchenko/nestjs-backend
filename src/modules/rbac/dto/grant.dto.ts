import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';

import { MAX_ACTIONS, NAME_PATTERN } from '../rbac.constants';
import { normalizeActionsTransform } from './permission.dto';

export class GrantDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  roleId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  permissionId!: string;

  @ApiPropertyOptional({
    example: ['read'],
    description:
      'Omit or send an empty list to grant all current and future actions.',
  })
  @Transform(normalizeActionsTransform)
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ACTIONS)
  @IsString({ each: true })
  @Matches(NAME_PATTERN, {
    each: true,
    message: 'each action has an invalid format',
  })
  actions?: string[];
}
