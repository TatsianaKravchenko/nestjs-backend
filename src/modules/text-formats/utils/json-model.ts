import { hasDuplicateKeys } from '@/core/http/http-setup';
import { ConverterFailure } from '@/modules/transformations/services/converter';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

const MAX_DEPTH = 200;

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A parsed document must be representable in JSON: finite numbers only (YAML
 * allows `.nan` and `.inf`) and a bounded depth (no stack overflow later).
 */
export function assertJsonCompatible(
  value: unknown,
  depth = 0,
): asserts value is JsonValue {
  if (depth > MAX_DEPTH) throw new ConverterFailure('invalid_input');
  if (value === null || typeof value === 'string') return;
  if (typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ConverterFailure('invalid_input');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonCompatible(item, depth + 1);
    return;
  }
  if (isObject(value)) {
    for (const item of Object.values(value)) {
      assertJsonCompatible(item, depth + 1);
    }
    return;
  }
  throw new ConverterFailure('invalid_input');
}

/**
 * RFC 8259 JSON: `JSON.parse` already rejects NaN, Infinity, comments, single
 * quotes and trailing data; a repeated object key is rejected on top of that.
 */
export function parseJson(text: string): JsonValue {
  try {
    const value: unknown = JSON.parse(text);
    if (hasDuplicateKeys(text)) throw new ConverterFailure('invalid_input');
    assertJsonCompatible(value);
    return value;
  } catch (error) {
    if (error instanceof ConverterFailure) throw error;
    throw new ConverterFailure('invalid_input');
  }
}

export function stringifyJson(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
