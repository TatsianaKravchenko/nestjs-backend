import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import { UserStatus } from '../../entities/user.entity';
import {
  SEARCH_BY,
  type SearchBy,
  type UserSearch,
} from '../utils/user-search';

export const LIST_QUERY_FIELDS = [
  'cursor',
  'limit',
  'searchBy',
  'q',
  'status',
  'sort',
  'order',
] as const;

export const SORT_FIELDS = ['createdAt', 'id'] as const;
export type SortField = (typeof SORT_FIELDS)[number];
export const SORT_ORDERS = ['desc', 'asc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** Raw query string as validated by class-validator (before normalization). */
export class ListUsersQueryDto {
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
  @IsIn(SEARCH_BY)
  searchBy?: SearchBy;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsIn(Object.values(UserStatus))
  status?: UserStatus;

  @IsOptional()
  @IsIn(SORT_FIELDS)
  sort?: SortField;

  @IsOptional()
  @IsIn(SORT_ORDERS)
  order?: SortOrder;
}

/** The validated, normalized query handed to the service. */
export interface ListUsersQuery {
  cursor?: string;
  limit: number;
  search?: UserSearch;
  status?: UserStatus;
  sort: SortField;
  order: SortOrder;
  /** Names of the parameters the client sent (for the audit log; never values). */
  paramNames: string[];
}
