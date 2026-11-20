import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** The text fields of `POST /convert`; the file is the only other part. */
export const CONVERT_FIELDS = ['targetFormat', 'save'] as const;

export class ConvertFieldsDto {
  @ApiProperty({ enum: ['csv', 'json', 'xml', 'yaml'] })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  targetFormat!: string;

  @ApiPropertyOptional({ enum: ['true', 'false'], default: 'false' })
  @IsOptional()
  @IsIn(['true', 'false'])
  save?: string;
}

export class FormatDirectionDto {
  @ApiProperty({ example: 'csv' })
  source!: string;

  @ApiProperty({ example: ['json', 'xml', 'yaml'], type: [String] })
  target!: string[];
}
