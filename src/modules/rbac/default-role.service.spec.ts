import { DefaultRoleService } from './default-role.service';
import { PolicyState } from './entities/policy-state.entity';
import { Role } from './entities/role.entity';

function build(options: { role?: { id: string } | null; inserted?: number }) {
  const insertBuilder = {
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    execute: jest.fn(),
  };
  // Calls: 1) insert user role, 2) bump version.
  insertBuilder.execute
    .mockResolvedValueOnce({
      raw: Array.from({ length: options.inserted ?? 1 }, () => ({
        user_id: 'u1',
      })),
    })
    .mockResolvedValueOnce({ raw: [{ version: 7 }] });

  const manager = {
    findOne: jest.fn((entity: unknown) =>
      Promise.resolve(entity === PolicyState ? { id: 1, version: 6 } : null),
    ),
    findOneBy: jest.fn((entity: unknown) =>
      Promise.resolve(entity === Role ? (options.role ?? null) : null),
    ),
    createQueryBuilder: jest.fn(() => insertBuilder),
  };
  return { service: new DefaultRoleService(), manager, insertBuilder };
}

describe('DefaultRoleService', () => {
  it('grants the user role and bumps the policy version', async () => {
    const { service, manager, insertBuilder } = build({
      role: { id: 'r-user' },
    });

    await service.assign(manager as never, 'u1');

    expect(manager.findOneBy).toHaveBeenCalledWith(Role, { name: 'user' });
    expect(insertBuilder.values).toHaveBeenCalledWith({
      userId: 'u1',
      roleId: 'r-user',
    });
    expect(insertBuilder.orIgnore).toHaveBeenCalled();
    expect(insertBuilder.set).toHaveBeenCalled(); // version bump
  });

  it('locks the policy row before touching roles', async () => {
    const { service, manager } = build({ role: { id: 'r-user' } });

    await service.assign(manager as never, 'u1');

    expect(manager.findOne.mock.invocationCallOrder[0]).toBeLessThan(
      manager.findOneBy.mock.invocationCallOrder[0],
    );
    expect(manager.findOne).toHaveBeenCalledWith(
      PolicyState,
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
  });

  it('does not bump the version when the user already has the role', async () => {
    const { service, manager, insertBuilder } = build({
      role: { id: 'r-user' },
      inserted: 0,
    });

    await service.assign(manager as never, 'u1');

    expect(insertBuilder.set).not.toHaveBeenCalled();
  });

  it('skips silently when the default role was removed', async () => {
    const { service, manager, insertBuilder } = build({ role: null });

    await expect(
      service.assign(manager as never, 'u1'),
    ).resolves.toBeUndefined();

    expect(insertBuilder.values).not.toHaveBeenCalled();
  });
});
