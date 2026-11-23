import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** The text fields of `POST /images/convert`; the file is the only other part. */
export const IMAGE_CONVERT_FIELDS = [
  'targetFormat',
  'options',
  'save',
] as const;

/** Longest `options` JSON that makes sense (four short keys). */
export const OPTIONS_FIELD_MAX_LENGTH = 512;

export const MAX_SIDE = 4096;

export class ImageConvertFieldsDto {
  @ApiProperty({ enum: ['png', 'jpeg'] })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  targetFormat!: string;

  @ApiPropertyOptional({
    description:
      'JSON object. `quality` (1-100) and `background` (#RRGGBB) only for ' +
      'jpeg; `width` and `height` (1-4096) only for an svg source.',
    example: '{"quality":85}',
  })
  @IsOptional()
  @IsString()
  @MaxLength(OPTIONS_FIELD_MAX_LENGTH)
  options?: string;

  @ApiPropertyOptional({ enum: ['true', 'false'], default: 'false' })
  @IsOptional()
  @IsIn(['true', 'false'])
  save?: string;
}

/** The contents of the `options` field. Unknown keys are rejected by the caller. */
export class ImageOptionsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  quality?: number;

  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  background?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SIDE)
  width?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SIDE)
  height?: number;
}
