import { invalidCursor } from '@/modules/auth/errors/auth.errors';

import type { HistoryFilters } from '../dto/history-query.dto';

export const HISTORY_CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Microsecond UTC text from the database: JS dates would truncate it. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const QUERY_KEYS = [
  'limit',
  'type',
  'sourceFormat',
  'targetFormat',
  'status',
  'createdAtFrom',
  'createdAtTo',
] as const;

/** The canonical query: the page size and every filter, a missing one as `null`. */
export interface CanonicalQuery extends HistoryFilters {
  limit: number;
}

export interface HistoryCursor {
  v: typeof HISTORY_CURSOR_VERSION;
  /** `created_at` of the last returned item (microsecond ISO, UTC). */
  createdAt: string;
  /** `id` of the last returned item. */
  id: string;
  q: CanonicalQuery;
}

/** Fixed key order, so equal queries always serialize equally. */
export const canonicalQuery = (
  limit: number,
  filters: HistoryFilters,
): CanonicalQuery => ({
  limit,
  type: filters.type,
  sourceFormat: filters.sourceFormat,
  targetFormat: filters.targetFormat,
  status: filters.status,
  createdAtFrom: filters.createdAtFrom,
  createdAtTo: filters.createdAtTo,
});

/**
 * Position + query, base64url JSON. It is not signed: it only moves within the
 * caller's own rows (the `user_id` condition is never part of it), so a forged
 * one can reveal nothing; structure, version and query are still verified.
 */
export function encodeCursor(
  position: { createdAt: string; id: string },
  query: CanonicalQuery,
): string {
  const payload: HistoryCursor = {
    v: HISTORY_CURSOR_VERSION,
    createdAt: position.createdAt,
    id: position.id,
    q: query,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

const sameKeys = (value: object, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort().join(',');
  return actual === [...keys].sort().join(',');
};

/** Every failure (structure, version, tampering, other query) is the same `400 invalid_cursor`. */
export function decodeCursor(
  token: string,
  expected: CanonicalQuery,
): HistoryCursor {
  if (token.length === 0 || token.length > MAX_CURSOR_LENGTH) {
    throw invalidCursor();
  }
  if (!BASE64URL.test(token)) throw invalidCursor();

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidCursor();
  }
  const payload = parsed as Record<string, unknown>;
  if (
    !sameKeys(payload, ['v', 'createdAt', 'id', 'q']) ||
    payload.v !== HISTORY_CURSOR_VERSION ||
    typeof payload.createdAt !== 'string' ||
    !TIMESTAMP.test(payload.createdAt) ||
    typeof payload.id !== 'string' ||
    !UUID.test(payload.id)
  ) {
    throw invalidCursor();
  }
  const q = payload.q;
  if (
    !q ||
    typeof q !== 'object' ||
    Array.isArray(q) ||
    !sameKeys(q, QUERY_KEYS)
  ) {
    throw invalidCursor();
  }
  const encoded = q as Record<string, unknown>;
  for (const key of QUERY_KEYS) {
    if (encoded[key] !== expected[key]) throw invalidCursor();
  }
  return payload as unknown as HistoryCursor;
}
