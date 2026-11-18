import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac } from 'crypto';

import type { ConfigService } from '@/core/config/config.service';

import {
  CURSOR_TTL_MS,
  type QueryShape,
  UserListCursorService,
} from './user-list-cursor.service';

const K1 = 'a'.repeat(32);
const K2 = 'b'.repeat(32);
const SHAPE: QueryShape = { sort: 'createdAt', order: 'desc' };
const ID = '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44';
const TS = '2026-01-01T10:00:00.123456Z';
const NOW = Date.parse('2026-06-01T00:00:00Z');

function service(env: Record<string, string | undefined>) {
  return new UserListCursorService({
    get: (key: string) => env[key],
  } as unknown as ConfigService);
}

const ENV = {
  USER_LIST_CURSOR_ACTIVE_KEY_ID: 'k1',
  USER_LIST_CURSOR_HMAC_KEYS: `k1:${K1},k2:${K2}`,
};

const position = (overrides = {}) => ({
  snapshotAt: '2026-01-02T00:00:00.000001Z',
  lastSortValue: TS,
  lastTieBreaker: ID,
  issuedAt: NOW,
  expiresAt: NOW + CURSOR_TTL_MS,
  ...overrides,
});

/** Re-signs an arbitrary payload with the given key (a "valid" forged cursor). */
function forge(payload: object, key = K1): string {
  const segment = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', key)
    .update(`users-list-cursor\n${segment}`)
    .digest('base64url');
  return `${segment}.${sig}`;
}

const decode = (token: string) =>
  JSON.parse(
    Buffer.from(token.split('.')[0], 'base64url').toString('utf8'),
  ) as Record<string, unknown>;

describe('UserListCursorService', () => {
  const cursors = service(ENV);

  it('round-trips a cursor and keeps the first-page times', () => {
    const token = cursors.issue(SHAPE, position());
    const payload = cursors.verify(token, SHAPE, NOW + 1000);
    expect(payload).toMatchObject({
      v: 1,
      kid: 'k1',
      sort: 'createdAt',
      order: 'desc',
      lastSortValue: TS,
      lastTieBreaker: ID,
      issuedAt: NOW,
      expiresAt: NOW + CURSOR_TTL_MS,
    });
  });

  it('has the documented fields and no personal data', () => {
    const shape: QueryShape = {
      ...SHAPE,
      status: 'active',
      search: { by: 'email', value: 'jane@example.com' },
    };
    const token = cursors.issue(shape, position());
    expect(token.split('.')).toHaveLength(2);
    expect(Object.keys(decode(token)).sort()).toEqual(
      [
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
      ].sort(),
    );
    const raw = Buffer.from(token.split('.')[0], 'base64url').toString();
    expect(raw).not.toContain('jane');
    expect(raw).not.toContain('active');
  });

  it('rejects a tampered payload', () => {
    const token = cursors.issue(SHAPE, position());
    const [segment, sig] = token.split('.');
    const payload = decode(token);
    payload.lastTieBreaker = '00000000-0000-4000-8000-000000000000';
    const tampered = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
    expect(segment).not.toBe(tampered.split('.')[0]);
    expect(() => cursors.verify(tampered, SHAPE, NOW)).toThrow(
      BadRequestException,
    );
  });

  it('rejects a tampered or truncated signature', () => {
    const token = cursors.issue(SHAPE, position());
    const [segment, sig] = token.split('.');
    const flipped = sig[0] === 'A' ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
    expect(() => cursors.verify(`${segment}.${flipped}`, SHAPE, NOW)).toThrow(
      BadRequestException,
    );
    expect(() =>
      cursors.verify(`${segment}.${sig.slice(2)}`, SHAPE, NOW),
    ).toThrow(BadRequestException);
  });

  it.each([
    'garbage',
    '',
    'a.b.c',
    'a b.c',
    '.',
    `${'a'.repeat(3000)}.x`,
    `${Buffer.from('not json').toString('base64url')}.abc`,
    `${Buffer.from('null').toString('base64url')}.abc`,
  ])('rejects malformed cursor %j', (token) => {
    expect(() => cursors.verify(token, SHAPE, NOW)).toThrow(
      BadRequestException,
    );
  });

  it('rejects an expired cursor', () => {
    const token = cursors.issue(SHAPE, position());
    expect(() => cursors.verify(token, SHAPE, NOW + CURSOR_TTL_MS)).toThrow(
      BadRequestException,
    );
    expect(() =>
      cursors.verify(token, SHAPE, NOW + CURSOR_TTL_MS - 1),
    ).not.toThrow();
  });

  it('rejects a cursor whose lifetime was extended (signed with the real key)', () => {
    const payload = decode(cursors.issue(SHAPE, position()));
    payload.expiresAt = NOW + 2 * CURSOR_TTL_MS;
    expect(() => cursors.verify(forge(payload), SHAPE, NOW)).toThrow(
      BadRequestException,
    );
  });

  it('rejects another query (queryTag mismatch)', () => {
    const token = cursors.issue(SHAPE, position());
    const other = { ...SHAPE, status: 'active' };
    expect(() => cursors.verify(token, other, NOW)).toThrow(
      BadRequestException,
    );
    expect(() =>
      cursors.verify(
        token,
        { ...SHAPE, search: { by: 'id', value: 'x' } },
        NOW,
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects another sort or order', () => {
    const token = cursors.issue(SHAPE, position());
    expect(() =>
      cursors.verify(token, { ...SHAPE, order: 'asc' }, NOW),
    ).toThrow(BadRequestException);
    expect(() => cursors.verify(token, { ...SHAPE, sort: 'id' }, NOW)).toThrow(
      BadRequestException,
    );
  });

  it('rejects an unknown kid and a version mismatch', () => {
    const payload = decode(cursors.issue(SHAPE, position()));
    expect(() =>
      cursors.verify(forge({ ...payload, kid: 'zz' }), SHAPE, NOW),
    ).toThrow(BadRequestException);
    expect(() =>
      cursors.verify(forge({ ...payload, v: 2 }), SHAPE, NOW),
    ).toThrow(BadRequestException);
  });

  it('rejects a cursor signed with another key under a known kid', () => {
    const payload = decode(cursors.issue(SHAPE, position()));
    expect(() => cursors.verify(forge(payload, K2), SHAPE, NOW)).toThrow(
      BadRequestException,
    );
  });

  it('rejects extra fields and malformed positions even with a valid signature', () => {
    const payload = decode(cursors.issue(SHAPE, position()));
    for (const bad of [
      { ...payload, extra: 1 },
      { ...payload, lastSortValue: 'yesterday' },
      { ...payload, lastTieBreaker: 'not-a-uuid' },
      { ...payload, snapshotAt: 'x' },
      { ...payload, sort: 'email' },
      { ...payload, order: 'up' },
      { ...payload, queryTag: 5 },
      { ...payload, issuedAt: 'now' },
    ]) {
      expect(() => cursors.verify(forge(bad), SHAPE, NOW)).toThrow(
        BadRequestException,
      );
    }
  });

  it('keeps accepting a cursor of a rotated-out but still listed key', () => {
    const old = service({
      USER_LIST_CURSOR_ACTIVE_KEY_ID: 'k2',
      USER_LIST_CURSOR_HMAC_KEYS: `k1:${K1},k2:${K2}`,
    }).issue(SHAPE, position());
    expect(decode(old).kid).toBe('k2');
    const rotated = service({
      USER_LIST_CURSOR_ACTIVE_KEY_ID: 'k1',
      USER_LIST_CURSOR_HMAC_KEYS: `k1:${K1},k2:${K2}`,
    });
    expect(() => rotated.verify(old, SHAPE, NOW)).not.toThrow();
    // ...and rejects it once the key is removed.
    const removed = service({
      USER_LIST_CURSOR_ACTIVE_KEY_ID: 'k1',
      USER_LIST_CURSOR_HMAC_KEYS: `k1:${K1}`,
    });
    expect(() => removed.verify(old, SHAPE, NOW)).toThrow(BadRequestException);
  });

  it('answers 503 for every operation when the keys are misconfigured', () => {
    const broken = service({
      USER_LIST_CURSOR_ACTIVE_KEY_ID: 'k1',
      USER_LIST_CURSOR_HMAC_KEYS: 'k1:short',
    });
    expect(() => broken.assertConfigured()).toThrow(
      ServiceUnavailableException,
    );
    expect(() => broken.issue(SHAPE, position())).toThrow(
      ServiceUnavailableException,
    );
    expect(() => broken.verify('a.b', SHAPE)).toThrow(
      ServiceUnavailableException,
    );
  });
});
