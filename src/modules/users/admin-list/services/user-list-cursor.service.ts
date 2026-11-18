import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

import { ConfigService } from '@/core/config/config.service';
import {
  invalidCursor,
  serviceUnavailable,
} from '@/modules/auth/errors/auth.errors';

import type { SortField, SortOrder } from '../dto/list-users-query.dto';
import { parseCursorKeys } from '../utils/cursor-keys';
import type { UserSearch } from '../utils/user-search';

export const CURSOR_VERSION = 1;
export const CURSOR_TTL_MS = 15 * 60 * 1000;
const CURSOR_DOMAIN = 'users-list-cursor';
const QUERY_DOMAIN = 'users-list-query';
const MAX_CURSOR_LENGTH = 2048;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * The signed cursor payload. It carries positions and an HMAC of the query
 * only: never the email, display name, status or search text.
 */
export interface CursorPayload {
  v: typeof CURSOR_VERSION;
  kid: string;
  sort: SortField;
  order: SortOrder;
  /** DB UTC clock of the first page, microsecond ISO string. */
  snapshotAt: string;
  /** Sort field value of the last row (`createdAt` microsecond ISO, or the id). */
  lastSortValue: string;
  /** The other of `createdAt` / `id` for the last row. */
  lastTieBreaker: string;
  queryTag: string;
  issuedAt: number;
  expiresAt: number;
}

/** What identifies "the same query" across pages (the page size is not part of it). */
export interface QueryShape {
  search?: UserSearch;
  status?: string;
  sort: SortField;
  order: SortOrder;
}

const b64 = (data: Buffer | string): string =>
  Buffer.from(data).toString('base64url');

/** Signs and verifies the keyset cursors of `GET /admin/users` (HMAC-SHA256, rotating key ids). */
@Injectable()
export class UserListCursorService {
  constructor(private readonly config: ConfigService) {}

  /** Parsed key settings; 503 when they are missing or weak (also fails readiness). */
  private keys() {
    const parsed = parseCursorKeys(
      this.config.get('USER_LIST_CURSOR_ACTIVE_KEY_ID'),
      this.config.get('USER_LIST_CURSOR_HMAC_KEYS'),
    );
    if (!parsed.ok) throw serviceUnavailable('Pagination is unavailable');
    return parsed;
  }

  /** Throws 503 if the cursor keys are misconfigured; call before querying. */
  assertConfigured(): void {
    this.keys();
  }

  queryTag(shape: QueryShape, key: Buffer): string {
    const canonical = JSON.stringify({
      searchBy: shape.search?.by ?? null,
      q: shape.search?.value ?? null,
      status: shape.status ?? null,
      sort: shape.sort,
      order: shape.order,
    });
    return b64(
      createHmac('sha256', key)
        .update(`${QUERY_DOMAIN}\n${canonical}`)
        .digest(),
    );
  }

  /** Signs a cursor with the active key; `issuedAt`/`expiresAt` are kept from the first page. */
  issue(
    shape: QueryShape,
    position: {
      snapshotAt: string;
      lastSortValue: string;
      lastTieBreaker: string;
      issuedAt: number;
      expiresAt: number;
    },
  ): string {
    const { activeKid, keys } = this.keys();
    const key = keys.get(activeKid) as Buffer;
    const payload: CursorPayload = {
      v: CURSOR_VERSION,
      kid: activeKid,
      sort: shape.sort,
      order: shape.order,
      snapshotAt: position.snapshotAt,
      lastSortValue: position.lastSortValue,
      lastTieBreaker: position.lastTieBreaker,
      queryTag: this.queryTag(shape, key),
      issuedAt: position.issuedAt,
      expiresAt: position.expiresAt,
    };
    const segment = b64(JSON.stringify(payload));
    return `${segment}.${b64(this.signature(key, segment))}`;
  }

  /**
   * Verifies signature (constant time), version, key id, expiry, field shapes
   * and that the query matches. Every failure is the same `400 invalid_cursor`.
   */
  verify(token: string, shape: QueryShape, now = Date.now()): CursorPayload {
    const { keys } = this.keys();
    if (token.length > MAX_CURSOR_LENGTH) throw invalidCursor();
    const parts = token.split('.');
    if (parts.length !== 2 || !parts.every((p) => BASE64URL.test(p))) {
      throw invalidCursor();
    }
    const [segment, signature] = parts;

    let payload: Partial<CursorPayload>;
    try {
      payload = JSON.parse(
        Buffer.from(segment, 'base64url').toString('utf8'),
      ) as Partial<CursorPayload>;
    } catch {
      throw invalidCursor();
    }
    const key =
      payload && typeof payload.kid === 'string'
        ? keys.get(payload.kid)
        : undefined;
    if (!key) throw invalidCursor();

    const expected = this.signature(key, segment);
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw invalidCursor();
    }

    const valid = this.validPayload(payload);
    if (!valid || valid.expiresAt <= now) throw invalidCursor();
    if (valid.sort !== shape.sort || valid.order !== shape.order) {
      throw invalidCursor();
    }
    const tag = Buffer.from(valid.queryTag);
    const wanted = Buffer.from(this.queryTag(shape, key));
    if (tag.length !== wanted.length || !timingSafeEqual(tag, wanted)) {
      throw invalidCursor();
    }
    return valid;
  }

  private signature(key: Buffer, segment: string): Buffer {
    return createHmac('sha256', key)
      .update(`${CURSOR_DOMAIN}\n${segment}`)
      .digest();
  }

  /** Strict shape check: exact key set, types and value formats. */
  private validPayload(payload: Partial<CursorPayload>): CursorPayload | null {
    const keys = Object.keys(payload).sort().join(',');
    const expected = [
      'v',
      'kid',
      'sort',
      'order',
      'snapshotAt',
      'lastSortValue',
      'lastTieBreaker',
      'queryTag',
      'issuedAt',
      'expiresAt',
    ]
      .sort()
      .join(',');
    if (keys !== expected || payload.v !== CURSOR_VERSION) return null;
    const { sort, order, snapshotAt, lastSortValue, lastTieBreaker } = payload;
    if (sort !== 'createdAt' && sort !== 'id') return null;
    if (order !== 'asc' && order !== 'desc') return null;
    if (typeof payload.queryTag !== 'string') return null;
    if (!Number.isSafeInteger(payload.issuedAt)) return null;
    if (payload.expiresAt !== (payload.issuedAt as number) + CURSOR_TTL_MS) {
      return null;
    }
    const [time, id] =
      sort === 'createdAt'
        ? [lastSortValue, lastTieBreaker]
        : [lastTieBreaker, lastSortValue];
    if (
      typeof snapshotAt !== 'string' ||
      !TIMESTAMP.test(snapshotAt) ||
      typeof time !== 'string' ||
      !TIMESTAMP.test(time) ||
      typeof id !== 'string' ||
      !UUID.test(id)
    ) {
      return null;
    }
    return payload as CursorPayload;
  }
}
