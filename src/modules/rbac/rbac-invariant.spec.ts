/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { EntityManager } from 'typeorm';

import { hasActiveManageHolder } from './rbac-invariant';

const USER = '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44';
const OTHER = '9a8b7c6d-1111-4222-8333-444455556666';

const managerWith = (rows: unknown[]) => {
  const query = jest.fn().mockResolvedValue(rows);
  return { manager: { query } as unknown as EntityManager, query };
};

describe('hasActiveManageHolder', () => {
  it('is true when a row is returned and false when none', async () => {
    expect(
      await hasActiveManageHolder(managerWith([{ '?column?': 1 }]).manager),
    ).toBe(true);
    expect(await hasActiveManageHolder(managerWith([]).manager)).toBe(false);
  });

  it('asks for rbac@manage without filters by default', async () => {
    const { manager, query } = managerWith([]);

    await hasActiveManageHolder(manager);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual(['rbac', 'manage', null, null]);
  });

  it('passes the excluded and the single user as parameters, never inline', async () => {
    const { manager, query } = managerWith([]);

    await hasActiveManageHolder(manager, { exclude: USER });
    await hasActiveManageHolder(manager, { only: OTHER });
    await hasActiveManageHolder(manager, { exclude: USER, only: OTHER });

    expect(query.mock.calls.map((call) => call[1])).toEqual([
      ['rbac', 'manage', USER, null],
      ['rbac', 'manage', null, OTHER],
      ['rbac', 'manage', USER, OTHER],
    ]);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).not.toContain(USER);
  });

  it('only counts active users (blocked, deleting and deleted never hold access)', async () => {
    const { manager, query } = managerWith([]);

    await hasActiveManageHolder(manager);

    const sql = (query.mock.calls[0][0] as string).replace(/\s+/g, ' ');
    expect(sql).toContain("u.status = 'active'");
    expect(sql).toContain('g.all_actions OR $2 = ANY (g.actions)');
  });

  it('propagates database errors so the caller can roll back', async () => {
    const query = jest.fn().mockRejectedValue(new Error('db down'));

    await expect(
      hasActiveManageHolder({ query } as unknown as EntityManager),
    ).rejects.toThrow('db down');
  });
});
