import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { ConfigService } from '@/core/config/config.service';
import type { AuthAuditService } from '@/modules/auth/services/auth-audit.service';

import type { ListUsersQuery } from '../dto/list-users-query.dto';
import { AdminUsersService } from './admin-users.service';
import { UserListCursorService } from './user-list-cursor.service';

const KEY = 'a'.repeat(32);
const ENV: Record<string, string> = {
  USER_LIST_CURSOR_ACTIVE_KEY_ID: 'k1',
  USER_LIST_CURSOR_HMAC_KEYS: `k1:${KEY}`,
  API_PUBLIC_URL: 'https://api.test/',
  PORT: '3000',
};
const SNAPSHOT = '2026-02-01T00:00:00.000000Z';
const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const row = (n: number, overrides = {}) => ({
  id: ID(n),
  email: `u${n}@example.test`,
  display_name: `User ${n}`,
  has_photo: true,
  status: 'active',
  created_at: new Date(`2026-01-01T00:00:0${n}.123Z`),
  updated_at: new Date(`2026-01-02T00:00:0${n}.456Z`),
  created_at_us: `2026-01-01T00:00:0${n}.123456Z`,
  ...overrides,
});

const base = (overrides: Partial<ListUsersQuery> = {}): ListUsersQuery => ({
  limit: 2,
  sort: 'createdAt',
  order: 'desc',
  paramNames: ['limit'],
  ...overrides,
});

describe('AdminUsersService', () => {
  const config = { get: (key: string) => ENV[key] } as unknown as ConfigService;
  const cursors = new UserListCursorService(config);
  const info = jest.fn();
  const warn = jest.fn();
  const audit = { info, warn } as unknown as AuthAuditService;
  const query = jest.fn();
  const transaction = jest.fn();
  const ctx = { requestId: 'req-1', actorUserId: 'admin-1' };
  let rows: unknown[];

  const service = () =>
    new AdminUsersService(
      { transaction } as unknown as DataSource,
      cursors,
      audit,
      config,
    );
  const lastSelect = () => {
    const call = query.mock.calls.find(([sql]) =>
      String(sql).includes('FROM users'),
    ) as [string, unknown[]];
    return { sql: call[0].replace(/\s+/g, ' '), params: call[1] };
  };

  beforeEach(() => {
    jest.resetAllMocks();
    rows = [];
    query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes('clock_timestamp')
          ? [{ snapshot_at: SNAPSHOT }]
          : sql.startsWith('SET LOCAL')
            ? []
            : rows,
      ),
    );
    transaction.mockImplementation((work: (m: unknown) => unknown) =>
      work({ query }),
    );
  });

  it('returns an empty page and no cursor for no rows', async () => {
    await expect(service().list(ctx, base())).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('sets the 2 s statement timeout, captures the snapshot and filters on it', async () => {
    await service().list(ctx, base());
    expect((query.mock.calls as unknown[][])[0][0]).toBe(
      'SET LOCAL statement_timeout = 2000',
    );
    const { sql, params } = lastSelect();
    expect(sql).toContain('created_at < $1::timestamptz');
    expect(params[0]).toBe(SNAPSHOT);
    expect(sql).toContain('ORDER BY created_at DESC, id DESC');
    expect(params[params.length - 1]).toBe(3); // limit + 1
  });

  it('never selects password_hash or photo_key', async () => {
    await service().list(ctx, base());
    const { sql } = lastSelect();
    expect(sql).not.toMatch(/password_hash/);
    expect(sql).not.toMatch(/SELECT[^F]*photo_key\s*,/);
    expect(sql).toContain('(photo_key IS NOT NULL) AS has_photo');
  });

  it('projects only the safe fields with a constructed photoUrl', async () => {
    rows = [row(1, { password_hash: 'secret', photo_key: 'k.webp' })];
    const { items } = await service().list(ctx, base());
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]).sort()).toEqual([
      'createdAt',
      'displayName',
      'email',
      'id',
      'photoUrl',
      'status',
      'updatedAt',
    ]);
    expect(items[0]).toMatchObject({
      id: ID(1),
      email: 'u1@example.test',
      photoUrl: `https://api.test/users/${ID(1)}/photo`,
      createdAt: '2026-01-01T00:00:01.123Z',
      updatedAt: '2026-01-02T00:00:01.456Z',
    });
    expect(JSON.stringify(items)).not.toContain('secret');
    expect(JSON.stringify(items)).not.toContain('k.webp');
  });

  it.each([
    ['no photo', { has_photo: false, status: 'active' }],
    ['deleting', { has_photo: true, status: 'deleting' }],
    ['deleted', { has_photo: true, status: 'deleted' }],
  ])('gives a null photoUrl for %s', async (_label, overrides) => {
    rows = [row(1, { ...overrides, display_name: null })];
    const { items } = await service().list(ctx, base());
    expect(items[0].photoUrl).toBeNull();
    expect(items[0].displayName).toBeNull();
  });

  it.each(['pending', 'active', 'blocked', 'deleting', 'deleted'])(
    'filters by status %s',
    async (status) => {
      await service().list(ctx, base({ status: status as never }));
      const { sql, params } = lastSelect();
      expect(sql).toContain('status = $2');
      expect(params[1]).toBe(status);
    },
  );

  it('falls back to the local URL when API_PUBLIC_URL is not set', async () => {
    rows = [row(1)];
    const local = {
      get: (key: string) => (key === 'API_PUBLIC_URL' ? '' : ENV[key]),
    } as unknown as ConfigService;
    const s = new AdminUsersService(
      { transaction } as unknown as DataSource,
      new UserListCursorService(local),
      audit,
      local,
    );
    const { items } = await s.list(ctx, base());
    expect(items[0].photoUrl).toBe(
      `http://localhost:3000/users/${ID(1)}/photo`,
    );
  });

  describe('search', () => {
    it('matches an email by an escaped literal prefix', async () => {
      await service().list(
        ctx,
        base({ search: { by: 'email', value: 'a%b_c\\' } }),
      );
      const { sql, params } = lastSelect();
      expect(sql).toContain(`email LIKE $2 ESCAPE '\\'`);
      expect(params[1]).toBe('a\\%b\\_c\\\\%');
    });

    it('matches a display name with the indexed expression and a not-null guard', async () => {
      await service().list(
        ctx,
        base({ search: { by: 'displayName', value: 'jo_e' } }),
      );
      const { sql, params } = lastSelect();
      expect(sql).toContain(
        `display_name IS NOT NULL AND lower(normalize(display_name, NFC)) LIKE $2 ESCAPE '\\'`,
      );
      expect(params[1]).toBe('jo\\_e%');
    });

    it('matches an id exactly', async () => {
      await service().list(ctx, base({ search: { by: 'id', value: ID(5) } }));
      const { sql, params } = lastSelect();
      expect(sql).toContain('id = $2::uuid');
      expect(params[1]).toBe(ID(5));
    });

    it('returns empty for a non-uuid id without querying the table', async () => {
      await expect(
        service().list(ctx, base({ search: { by: 'id', value: 'abc-123' } })),
      ).resolves.toEqual({ items: [], nextCursor: null });
      expect(transaction).not.toHaveBeenCalled();
    });
  });

  describe('pagination', () => {
    it('queries limit+1 rows and returns a cursor only when there is a next page', async () => {
      rows = [row(3), row(2), row(1)];
      const page = await service().list(ctx, base({ limit: 2 }));
      expect(page.items.map((i) => i.id)).toEqual([ID(3), ID(2)]);
      expect(page.nextCursor).toEqual(expect.any(String));

      rows = [row(2), row(1)];
      const last = await service().list(ctx, base({ limit: 2 }));
      expect(last.items).toHaveLength(2);
      expect(last.nextCursor).toBeNull();
    });

    it('points the cursor at the last returned row (microsecond precision)', async () => {
      rows = [row(3), row(2), row(1)];
      const { nextCursor } = await service().list(ctx, base({ limit: 2 }));
      const payload = cursors.verify(nextCursor as string, {
        sort: 'createdAt',
        order: 'desc',
      });
      expect(payload.lastSortValue).toBe('2026-01-01T00:00:02.123456Z');
      expect(payload.lastTieBreaker).toBe(ID(2));
      expect(payload.snapshotAt).toBe(SNAPSHOT);
    });

    it('swaps sort value and tie-breaker when sorting by id', async () => {
      rows = [row(1), row(2), row(3)];
      const { nextCursor } = await service().list(
        ctx,
        base({ limit: 2, sort: 'id', order: 'asc' }),
      );
      const payload = cursors.verify(nextCursor as string, {
        sort: 'id',
        order: 'asc',
      });
      expect(payload.lastSortValue).toBe(ID(2));
      expect(payload.lastTieBreaker).toBe('2026-01-01T00:00:02.123456Z');
      expect(lastSelect().sql).toContain('ORDER BY id ASC, created_at ASC');
    });

    it('continues from a cursor: reuses the snapshot, no new clock read, keyset predicate', async () => {
      rows = [row(3), row(2), row(1)];
      const first = await service().list(ctx, base({ limit: 2 }));
      query.mockClear();
      rows = [row(1)];
      await service().list(ctx, base({ cursor: first.nextCursor as string }));
      expect(query.mock.calls.some(([s]) => String(s).includes('clock'))).toBe(
        false,
      );
      const { sql, params } = lastSelect();
      expect(sql).toContain('(created_at, id) < ($2::timestamptz, $3::uuid)');
      expect(params.slice(0, 3)).toEqual([
        SNAPSHOT,
        '2026-01-01T00:00:02.123456Z',
        ID(2),
      ]);
    });

    it('uses > for ascending order and the (id, created_at) pair for sort=id', async () => {
      rows = [row(1), row(2), row(3)];
      const shape = { limit: 2, sort: 'id', order: 'asc' } as const;
      const first = await service().list(ctx, base(shape));
      rows = [];
      query.mockClear();
      await service().list(
        ctx,
        base({ ...shape, cursor: first.nextCursor as string }),
      );
      expect(lastSelect().sql).toContain(
        '(id, created_at) > ($2::uuid, $3::timestamptz)',
      );
    });

    it('preserves issuedAt and expiresAt from the first page', async () => {
      jest.useFakeTimers().setSystemTime(Date.parse('2026-06-01T00:00:00Z'));
      rows = [row(3), row(2), row(1)];
      const first = await service().list(ctx, base({ limit: 1 }));
      jest.setSystemTime(Date.parse('2026-06-01T00:05:00Z'));
      const second = await service().list(
        ctx,
        base({ limit: 1, cursor: first.nextCursor as string }),
      );
      const shape = { sort: 'createdAt', order: 'desc' } as const;
      const a = cursors.verify(first.nextCursor as string, shape);
      const b = cursors.verify(second.nextCursor as string, shape);
      expect([b.issuedAt, b.expiresAt]).toEqual([a.issuedAt, a.expiresAt]);
      jest.useRealTimers();
    });

    it('rejects a cursor used with a different filter before querying', async () => {
      rows = [row(3), row(2), row(1)];
      const first = await service().list(ctx, base({ limit: 2 }));
      transaction.mockClear();
      await expect(
        service().list(
          ctx,
          base({
            cursor: first.nextCursor as string,
            status: 'blocked' as never,
          }),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(transaction).not.toHaveBeenCalled();
    });
  });

  describe('failures', () => {
    it('answers 503 on a statement timeout or any database error', async () => {
      transaction.mockRejectedValue(
        Object.assign(new Error('canceling statement'), { code: '57014' }),
      );
      await expect(service().list(ctx, base())).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('answers 503 when the cursor keys are misconfigured, before any query', async () => {
      const broken = {
        get: (key: string) =>
          key === 'USER_LIST_CURSOR_HMAC_KEYS' ? 'k1:x' : ENV[key],
      } as unknown as ConfigService;
      const s = new AdminUsersService(
        { transaction } as unknown as DataSource,
        new UserListCursorService(broken),
        audit,
        broken,
      );
      await expect(s.list(ctx, base())).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(transaction).not.toHaveBeenCalled();
    });
  });

  describe('audit log', () => {
    it('records ids, parameter names, page size, hasNext and duration only', async () => {
      rows = [row(3), row(2), row(1)];
      await service().list(
        ctx,
        base({
          limit: 2,
          search: { by: 'email', value: 'secret@example.test' },
          paramNames: ['limit', 'q', 'searchBy'],
        }),
      );
      expect(info).toHaveBeenCalledTimes(1);
      const [event, fields] = info.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(event).toBe('users.admin_list');
      expect(fields).toMatchObject({
        requestId: 'req-1',
        actorUserId: 'admin-1',
        params: 'limit,q,searchBy',
        pageSize: 2,
        hasNext: true,
        result: 'success',
      });
      expect(typeof fields.durationMs).toBe('number');
      const logged = JSON.stringify(info.mock.calls);
      expect(logged).not.toContain('secret@example.test');
      expect(logged).not.toContain('u3@example.test');
    });

    it('logs failures without the cursor or the query values', async () => {
      await expect(
        service().list(ctx, base({ cursor: 'tampered.cursor' })),
      ).rejects.toThrow(BadRequestException);
      expect(warn).toHaveBeenCalledWith(
        'users.admin_list.failed',
        expect.objectContaining({ status: 400, result: 'invalid_request' }),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('tampered');
    });
  });
});
