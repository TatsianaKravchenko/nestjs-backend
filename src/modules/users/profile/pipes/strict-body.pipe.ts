import { PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import {
  invalidRequest,
  ApiErrorCode,
} from '@/modules/auth/errors/auth.errors';

/**
 * Exact-shape body validation. The global pipe only strips unknown fields;
 * here they are an error. Declare the parameter as `unknown` so the global
 * pipe leaves it alone, then this pipe returns the validated DTO instance.
 * Rejects non-objects, an empty object, unknown keys and failed constraints (400).
 */
export class StrictBodyPipe<T extends object> implements PipeTransform {
  constructor(
    private readonly dto: new () => T,
    private readonly allowed: readonly string[],
    private readonly options: { allowEmpty?: boolean } = {},
  ) {}

  transform(value: unknown): T {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw invalidRequest(
        'Body must be a JSON object',
        ApiErrorCode.ValidationError,
      );
    }
    const keys = Object.keys(value);
    if (keys.length === 0 && !this.options.allowEmpty) {
      throw invalidRequest(
        'Body must not be empty',
        ApiErrorCode.ValidationError,
      );
    }
    const unknown = keys.filter((key) => !this.allowed.includes(key));
    if (unknown.length > 0) {
      throw invalidRequest(
        `Unknown field: ${unknown.join(', ')}`,
        ApiErrorCode.ValidationError,
      );
    }
    const instance = plainToInstance(this.dto, value);
    const errors = validateSync(instance, { forbidUnknownValues: true });
    if (errors.length > 0) {
      throw invalidRequest(
        `Invalid field: ${errors.map((e) => e.property).join(', ')}`,
        ApiErrorCode.ValidationError,
      );
    }
    return instance;
  }
}
