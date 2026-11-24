import { Injectable, PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import {
  ApiErrorCode,
  invalidRequest,
} from '@/modules/auth/errors/auth.errors';

import {
  DEFAULT_LIMIT,
  HISTORY_QUERY_FIELDS,
  HistoryQuery,
  HistoryQueryDto,
} from '../dto/history-query.dto';
import { ConverterRegistry } from '../services/converter.registry';
import { isFormat, normalizeFormat } from '../utils/formats';

const bad = (message: string) =>
  invalidRequest(message, ApiErrorCode.ValidationError);

/** Calendar and clock fields of a string that already matched `TIMESTAMP_PATTERN`. */
function hasValidFields(value: string): boolean {
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    ) ?? [];
  if (year === undefined) return false;
  const [y, m, d] = [Number(year), Number(month), Number(day)];
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d &&
    Number(hour) < 24 &&
    Number(minute) < 60 &&
    Number(second) < 60 &&
    Number(offsetHour ?? 0) < 24 &&
    Number(offsetMinute ?? 0) < 60
  );
}

/**
 * Strict whitelist for the history endpoints: unknown and repeated parameters,
 * out-of-range values (no clamping), formats no converter supports and an
 * empty or inverted time range are all 400. It runs after the access guards,
 * so a caller without the permission never reaches it.
 */
@Injectable()
export class HistoryQueryPipe implements PipeTransform {
  constructor(private readonly registry: ConverterRegistry) {}

  transform(value: unknown): HistoryQuery {
    const raw = value && typeof value === 'object' ? value : {};
    const entries = Object.entries(raw as Record<string, unknown>);

    const allowed: readonly string[] = HISTORY_QUERY_FIELDS;
    const unknown = entries.filter(([name]) => !allowed.includes(name));
    if (unknown.length > 0) {
      throw bad(`Unknown parameter: ${unknown.map(([n]) => n).join(', ')}`);
    }
    for (const [name, v] of entries) {
      if (typeof v !== 'string') throw bad(`Invalid or repeated ${name}`);
    }

    const dto = plainToInstance(HistoryQueryDto, raw);
    const errors = validateSync(dto, { forbidUnknownValues: true });
    if (errors.length > 0) {
      throw bad(
        `Invalid parameter: ${errors.map((e) => e.property).join(', ')}`,
      );
    }
    if (dto.cursor === '') throw bad('Invalid parameter: cursor');

    const directions = this.registry.directions();
    const sourceFormat = this.format(
      'sourceFormat',
      dto.sourceFormat,
      new Set(directions.map((d) => d.source)),
    );
    const targetFormat = this.format(
      'targetFormat',
      dto.targetFormat,
      new Set(directions.map((d) => d.target)),
    );

    const createdAtFrom = this.timestamp('createdAtFrom', dto.createdAtFrom);
    const createdAtTo = this.timestamp('createdAtTo', dto.createdAtTo);
    if (
      createdAtFrom !== null &&
      createdAtTo !== null &&
      !(Date.parse(createdAtFrom) < Date.parse(createdAtTo))
    ) {
      throw bad('createdAtFrom must be earlier than createdAtTo');
    }

    return {
      cursor: dto.cursor,
      limit: dto.limit ?? DEFAULT_LIMIT,
      filters: {
        type: dto.type ?? null,
        sourceFormat,
        targetFormat,
        status: dto.status ?? null,
        createdAtFrom,
        createdAtTo,
      },
    };
  }

  private format(
    name: string,
    value: string | undefined,
    supported: Set<string>,
  ): string | null {
    if (value === undefined) return null;
    const normalized = normalizeFormat(value);
    if (!isFormat(normalized) || !supported.has(normalized)) {
      throw bad(`Unsupported format: ${name}`);
    }
    return normalized;
  }

  /** Canonical UTC `toISOString()` form, or `null` when not sent. */
  private timestamp(name: string, value: string | undefined): string | null {
    if (value === undefined) return null;
    const time = Date.parse(value);
    // `Date.parse` rolls impossible dates over (Feb 30 -> Mar 2): check the fields.
    if (Number.isNaN(time) || !hasValidFields(value)) {
      throw bad(`Invalid parameter: ${name}`);
    }
    return new Date(time).toISOString();
  }
}
