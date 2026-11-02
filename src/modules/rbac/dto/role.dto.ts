import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import { MAX_DESCRIPTION_LENGTH, NAME_PATTERN } from '../rbac.constants';
import {
  normalizeDescriptionTransform,
  normalizeNameTransform,
} from '../rbac.utils';

export class RoleDto {
  @ApiProperty({
    example: 'editor',
    description: 'Trimmed and lowercased. 1-64 chars: a-z, 0-9, ".", "_", "-".',
  })
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
}
