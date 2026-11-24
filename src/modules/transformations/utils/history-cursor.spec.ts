import { BadRequestException } from '@nestjs/common';

import {
  canonicalQuery,
  decodeCursor,
  encodeCursor,
  HISTORY_CURSOR_VERSION,
} from './history-cursor';

const ID = '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44';
const AT = '2026-01-02T03:04:05.123456Z';
const NO_FILTERS = {
  type: null,
  sourceFormat: null,
  targetFormat: null,
  status: null,
  createdAtFrom: null,
  createdAtTo: null,
};
const query = canonicalQuery(20, NO_FILTERS);

const raw = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
const valid = () => ({ v: 1, createdAt: AT, id: ID, q: { ...query } });
const unpack = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token, 'base64url').toString()) as Record<
    string,
    unknown
  >;

describe('history cursor', () => {
  it('round-trips the position and the canonical query', () => {
    const token = encodeCursor({ createdAt: AT, id: ID }, query);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(token, query)).toEqual(valid());
  });

  it('encodes the version and every missing filter explicitly as null', () => {
    const payload = unpack(encodeCursor({ createdAt: AT, id: ID }, query));
    expect(payload.v).toBe(HISTORY_CURSOR_VERSION);
    expect(payload.q).toEqual({ limit: 20, ...NO_FILTERS });
  });

  it('carries only version, position and query (no user id or e-mail)', () => {
    const payload = unpack(encodeCursor({ createdAt: AT, id: ID }, query));
    expect(Object.keys(payload)).toEqual(['v', 'createdAt', 'id', 'q']);
  });

  it.each([
    ['empty', ''],
    ['not base64url', 'a b!'],
    ['too long', 'A'.repeat(1025)],
    ['not json', Buffer.from('nope').toString('base64url')],
    ['json null', raw(null)],
    ['json array', raw([])],
    ['wrong version', raw({ ...valid(), v: 2 })],
    ['extra key', raw({ ...valid(), extra: 1 })],
    ['missing key', raw({ v: 1, createdAt: AT, id: ID })],
    ['bad timestamp', raw({ ...valid(), createdAt: '2026-01-02' })],
    [
      'millisecond timestamp',
      raw({ ...valid(), createdAt: '2026-01-02T03:04:05.123Z' }),
    ],
    ['bad id', raw({ ...valid(), id: 'nope' })],
    ['id not a string', raw({ ...valid(), id: 5 })],
    ['q array', raw({ ...valid(), q: [] })],
    ['q null', raw({ ...valid(), q: null })],
    ['q wrong keys', raw({ ...valid(), q: { limit: 20 } })],
  ])('rejects a malformed cursor: %s', (_name, token) => {
    expect(() => decodeCursor(token, query)).toThrow(BadRequestException);
  });

  it('rejects a cursor of another page size or filter set', () => {
    const token = encodeCursor({ createdAt: AT, id: ID }, query);
    expect(() => decodeCursor(token, canonicalQuery(21, NO_FILTERS))).toThrow(
      BadRequestException,
    );
    expect(() =>
      decodeCursor(
        token,
        canonicalQuery(20, { ...NO_FILTERS, status: 'error' as never }),
      ),
    ).toThrow(BadRequestException);
  });

  it('answers every failure with invalid_cursor', () => {
    let error: BadRequestException | undefined;
    try {
      decodeCursor('###', query);
    } catch (e) {
      error = e as BadRequestException;
    }
    expect(error?.getResponse()).toMatchObject({
      statusCode: 400,
      code: 'invalid_cursor',
    });
  });
});
