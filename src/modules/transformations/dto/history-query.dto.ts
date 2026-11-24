import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

import {
  TransformationStatus,
  TransformationType,
} from '../entities/transformation.entity';

export const HISTORY_QUERY_FIELDS = [
  'cursor',
  'limit',
  'type',
  'sourceFormat',
  'targetFormat',
  'status',
  'createdAtFrom',
  'createdAtTo',
] as const;

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** ISO 8601 date-time with an explicit zone (`Z` or an offset). */
export const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** Raw query string as validated by class-validator (before normalization). */
export class HistoryQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  // Only plain decimal digits are numbers: "1e1", "+5", "5.0" and " 5" stay strings and fail.
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^\d{1,6}$/.test(value)
      ? Number(value)
      : value,
  )
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit?: number;

  @IsOptional()
  @IsIn(Object.values(TransformationType))
  type?: TransformationType;

  @IsOptional()
  @IsString()
  sourceFormat?: string;

  @IsOptional()
  @IsString()
  targetFormat?: string;

  @IsOptional()
  @IsIn(Object.values(TransformationStatus))
  status?: TransformationStatus;

  @IsOptional()
  @Matches(TIMESTAMP_PATTERN)
  createdAtFrom?: string;

  @IsOptional()
  @Matches(TIMESTAMP_PATTERN)
  createdAtTo?: string;
}

/** The filters that identify "the same query" across pages (all explicit; `null` = not set). */
export interface HistoryFilters {
  type: TransformationType | null;
  sourceFormat: string | null;
  targetFormat: string | null;
  status: TransformationStatus | null;
  /** UTC, inclusive; canonical `toISOString()` form. */
  createdAtFrom: string | null;
  /** UTC, exclusive; canonical `toISOString()` form. */
  createdAtTo: string | null;
}

/** The validated, normalized query handed to the service. */
export interface HistoryQuery {
  cursor?: string;
  limit: number;
  filters: HistoryFilters;
}
