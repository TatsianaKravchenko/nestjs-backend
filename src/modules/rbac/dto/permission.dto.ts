import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import {
  MAX_ACTIONS,
  MAX_DESCRIPTION_LENGTH,
  NAME_PATTERN,
} from '../rbac.constants';
import {
  normalizeDescriptionTransform,
  normalizeNameTransform,
} from '../rbac.utils';

export const normalizeActionsTransform = ({
  value,
}: {
  value: unknown;
}): unknown =>
  Array.isArray(value)
    ? (value as unknown[]).map((item) =>
        normalizeNameTransform({ value: item }),
      )
    : value;

export class PermissionDto {
  @ApiProperty({ example: 'users' })
  @Transform(normalizeNameTransform)
  @IsString()
  @Matches(NAME_PATTERN, { message: 'name has an invalid format' })
  name!: string;

  @ApiPropertyOptional({ maxLength: MAX_DESCRIPTION_LENGTH, nullable: true })
  @Transform(normalizeDescriptionTransform)
  @IsOptional()
  @IsString()
  @MaxLength(MAX_DESCRIPTION_LENGTH)
  description?: string | null;

  @ApiProperty({
    example: ['read', 'update'],
    description: `1-${MAX_ACTIONS} unique actions, trimmed and lowercased.`,
  })
  @Transform(normalizeActionsTransform)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ACTIONS)
  @IsString({ each: true })
  @Matches(NAME_PATTERN, {
    each: true,
    message: 'each action has an invalid format',
  })
  actions!: string[];
}
