import { HttpException } from '@nestjs/common';

import type { HistoryQuery } from '../dto/history-query.dto';
import { canonicalQuery, encodeCursor } from '../utils/history-cursor';
import { TransformationHistoryReader } from './transformation-history-reader.service';

const ACTOR = '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44';
const TARGET = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const NO_FILTERS = {
  type: null,
  sourceFormat: null,
  targetFormat: null,
  status: null,
  createdAtFrom: null,
  createdAtTo: null,
};

const row = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  type: 'file',
  source_format: 'csv',
  target_format: 'json',
  status: 'success',
  input_size: '10',
  output_size: '20',
  duration_ms: 5,
  error_code: null,
  created_at: new Date('2026-01-02T03:04:05.123Z'),
  created_at_us: '2026-01-02T03:04:05.123456Z',
  ...overrides,
});

const q = (overrides: Partial<HistoryQuery> = {}): HistoryQuery => ({
  limit: 2,
  filters: { ...NO_FILTERS },
  ...overrides,
});

describe('TransformationHistoryReader', () => {
  const manager = { query: jest.fn() };
  const dataSource = {
    query: jest.fn(),
    transaction: jest.fn((fn: (m: typeof manager) => unknown) => fn(manager)),
  };
  const audit = { info: jest.fn(), warn: jest.fn() };
  const reader = new TransformationHistoryReader(
    dataSource as never,
    audit as never,
  );
  const ctx = { requestId: 'req-1', actorUserId: ACTOR };

  /** The page query is the one after `SET LOCAL`. */
  const pageCall = () => manager.query.mock.calls[1] as [string, unknown[]];

  beforeEach(() => {
    jest.clearAllMocks();
    dataSource.transaction.mockImplementation((fn) => fn(manager));
  });

  it('fetches limit + 1 rows in created_at DESC, id DESC order and scopes by the actor', async () => {
    manager.query.mockResolvedValueOnce([]).mockResolvedValueOnce([row(1)]);
    await reader.list(ctx, q());
    const [sql, params] = pageCall();
    expect(sql).toContain('ORDER BY created_at DESC, id DESC');
    expect(sql).not.toMatch(/OFFSET/i);
    expect(sql).toContain('user_id = $1');
    expect(params[0]).toBe(ACTOR);
    expect(params[params.length - 1]).toBe(3);
  });

  it('projects the contract fields, with the 2.4 storage defaults, and nothing else', async () => {
    manager.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        row(1, { status: 'error', output_size: null, error_code: 'timeout' }),
      ]);
    const { items, nextCursor } = await reader.list(ctx, q());
    expect(nextCursor).toBeNull();
    expect(items).toEqual([
      {
        id: '00000000-0000-4000-8000-000000000001',
        type: 'file',
        sourceFormat: 'csv',
        targetFormat: 'json',
        status: 'error',
        inputSize: 10,
        outputSize: null,
        durationMs: 5,
        errorCode: 'timeout',
        createdAt: '2026-01-02T03:04:05.123Z',
        storageStatus: 'not_requested',
        hasStoredFile: false,
        fileExpiresAt: null,
      },
    ]);
    expect(JSON.stringify(items)).not.toMatch(/user|email|storage_key|name/i);
  });

  it('does not select user_id or touch the stored-object table', async () => {
    manager.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await reader.list(ctx, q());
    const [sql] = pageCall();
    const selected = sql.slice(0, sql.indexOf('FROM'));
    expect(selected).not.toContain('user_id');
    expect(sql).not.toContain('transformation_objects');
  });

  it('returns a cursor of the last returned item (not the extra row) when a next page exists', async () => {
    manager.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row(3), row(2), row(1)]);
    const { items, nextCursor } = await reader.list(ctx, q());
    expect(items.map((i) => i.id.slice(-1))).toEqual(['3', '2']);
    const expected = encodeCursor(
      { createdAt: '2026-01-02T03:04:05.123456Z', id: row(2).id },
      canonicalQuery(2, NO_FILTERS),
    );
    expect(nextCursor).toBe(expected);
  });

  it('has no next page when exactly limit rows remain', async () => {
    manager.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row(2), row(1)]);
    const { items, nextCursor } = await reader.list(ctx, q());
    expect(items).toHaveLength(2);
    expect(nextCursor).toBeNull();
  });

  it('returns an empty page for no rows', async () => {
    manager.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(reader.list(ctx, q())).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('continues after the cursor with a (created_at, id) row comparison', async () => {
    const cursor = encodeCursor(
      { createdAt: '2026-01-02T03:04:05.123456Z', id: row(2).id },
      canonicalQuery(2, NO_FILTERS),
    );
    manager.query.mockResolvedValueOnce([]).mockResolvedValueOnce([row(1)]);
    await reader.list(ctx, q({ cursor }));
    const [sql, params] = pageCall();
    expect(sql).toContain('(created_at, id) < (');
    expect(params).toContain('2026-01-02T03:04:05.123456Z');
    expect(params).toContain(row(2).id);
  });

  it('applies every filter with bound parameters', async () => {
    manager.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await reader.list(
      ctx,
      q({
        filters: {
          type: 'image' as never,
          sourceFormat: 'png',
          targetFormat: 'jpeg',
          status: 'error' as never,
          createdAtFrom: '2026-01-01T00:00:00.000Z',
          createdAtTo: '2026-02-01T00:00:00.000Z',
        },
      }),
    );
    const [sql, params] = pageCall();
    for (const part of [
      'type = $',
      'source_format = $',
      'target_format = $',
      'status = $',
      'created_at >= $',
      'created_at < $',
    ]) {
      expect(sql).toContain(part);
    }
    expect(params).toEqual(
      expect.arrayContaining([
        'image',
        'png',
        'jpeg',
        'error',
        '2026-01-01T00:00:00.000Z',
        '2026-02-01T00:00:00.000Z',
      ]),
    );
    expect(sql).not.toContain('png');
  });

  it('rejects a cursor of another limit or filter set with 400 before reading', async () => {
    const cursor = encodeCursor(
      { createdAt: '2026-01-02T03:04:05.123456Z', id: row(2).id },
      canonicalQuery(50, NO_FILTERS),
    );
    await expect(reader.list(ctx, q({ cursor }))).rejects.toMatchObject({
      status: 400,
    });
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(audit.warn).toHaveBeenCalledWith(
      'transformations.history.list_failed',
      expect.objectContaining({ result: 'invalid_request', status: 400 }),
    );
  });

  describe('administrator mode', () => {
    const admin = { ...ctx, targetUserId: TARGET };

    it('reads the target user and logs self/admin mode with the target', async () => {
      dataSource.query.mockResolvedValueOnce([{ '?column?': 1 }]);
      manager.query.mockResolvedValueOnce([]).mockResolvedValueOnce([row(1)]);
      await reader.list(admin, q());
      expect(pageCall()[1][0]).toBe(TARGET);
      expect(audit.info).toHaveBeenCalledWith(
        'transformations.history.list',
        expect.objectContaining({
          mode: 'admin',
          actorUserId: ACTOR,
          targetUserId: TARGET,
        }),
      );
    });

    it('404 when the target does not exist, without reading history', async () => {
      dataSource.query.mockResolvedValueOnce([]);
      await expect(reader.list(admin, q())).rejects.toMatchObject({
        status: 404,
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(audit.warn).toHaveBeenCalledWith(
        'transformations.history.list_failed',
        expect.objectContaining({ result: 'not_found', status: 404 }),
      );
    });

    it('404 for an id that is not a uuid, without a database lookup', async () => {
      await expect(
        reader.list({ ...ctx, targetUserId: 'nope' }, q()),
      ).rejects.toMatchObject({ status: 404 });
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('503 when the user lookup fails', async () => {
      dataSource.query.mockRejectedValueOnce(new Error('db down'));
      await expect(reader.list(admin, q())).rejects.toMatchObject({
        status: 503,
      });
    });
  });

  describe('audit', () => {
    it('logs ids, filter names, limit, item count, outcome and duration only', async () => {
      manager.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([row(3), row(2), row(1)]);
      const cursor = encodeCursor(
        { createdAt: '2026-01-02T03:04:05.123456Z', id: row(9).id },
        canonicalQuery(2, { ...NO_FILTERS, sourceFormat: 'csv' }),
      );
      await reader.list(
        ctx,
        q({ cursor, filters: { ...NO_FILTERS, sourceFormat: 'csv' } }),
      );
      expect(audit.info).toHaveBeenCalledTimes(1);
      const [event, fields] = audit.info.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(event).toBe('transformations.history.list');
      expect(fields).toEqual({
        requestId: 'req-1',
        actorUserId: ACTOR,
        mode: 'self',
        filters: 'sourceFormat',
        limit: 2,
        itemCount: 2,
        hasNext: true,
        result: 'success',
        durationMs: expect.any(Number) as number,
      });
      expect(JSON.stringify(fields)).not.toContain(cursor);
      expect(JSON.stringify(fields)).not.toContain('csv"');
    });
  });

  it('503 when the page query fails (including the statement timeout)', async () => {
    manager.query
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('canceling statement'));
    const error = await reader.list(ctx, q()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(503);
    expect(audit.warn).toHaveBeenCalledWith(
      'transformations.history.list_failed',
      expect.objectContaining({ result: 'unavailable', status: 503 }),
    );
  });

  it('turns an unexpected non-HTTP error into 503', async () => {
    dataSource.transaction.mockImplementationOnce(() => {
      throw new TypeError('boom');
    });
    await expect(reader.list(ctx, q())).rejects.toMatchObject({ status: 503 });
  });
});
