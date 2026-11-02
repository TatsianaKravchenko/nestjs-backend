/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { User } from '@/modules/users/entities/user.entity';

import { Permission } from './entities/permission.entity';
import { PolicyState } from './entities/policy-state.entity';
import { RoleGrant } from './entities/role-grant.entity';
import { Role } from './entities/role.entity';
import { UserRole } from './entities/user-role.entity';
import { PolicySnapshotService } from './policy-snapshot.service';
import { RbacAdminService } from './rbac-admin.service';

type Row = Record<string, any>;
type Entity = new () => object;

/**
 * In-memory stand-in for the entity manager and data source. A transaction
 * restores the previous data when the work throws, like a real rollback.
 */
class FakeDb {
  tables = new Map<Entity, Row[]>();
  version = 1;
  seq = 0;
  failWith: unknown = null;

  constructor() {
    for (const entity of [Role, Permission, RoleGrant, UserRole, User]) {
      this.tables.set(entity as Entity, []);
    }
  }

  rows(entity: Entity): Row[] {
    return this.tables.get(entity)!;
  }

  seed(entity: Entity, row: Row): Row {
    const full = { id: `id-${++this.seq}`, ...row };
    this.rows(entity).push(full);
    return full;
  }

  private matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, expected]) => {
      const wanted = expected?._type === 'in' ? expected._value : [expected];
      return wanted.includes(row[key]);
    });
  }

  manager = {
    findOne: jest.fn((entity: Entity, options: any) => {
      this.guard();
      if (entity === (PolicyState as Entity)) {
        return Promise.resolve({ id: 1, version: this.version });
      }
      return Promise.resolve(
        this.rows(entity).find((r) => this.matches(r, options.where)) ?? null,
      );
    }),
    findOneBy: jest.fn((entity: Entity, where: Row) => {
      this.guard();
      return Promise.resolve(
        this.rows(entity).find((r) => this.matches(r, where)) ?? null,
      );
    }),
    findBy: jest.fn((entity: Entity, where: Row) => {
      this.guard();
      return Promise.resolve(
        this.rows(entity).filter((r) => this.matches(r, where)),
      );
    }),
    find: jest.fn((entity: Entity) => {
      this.guard();
      return Promise.resolve([...this.rows(entity)]);
    }),
    countBy: jest.fn((entity: Entity, where: Row) =>
      Promise.resolve(
        this.rows(entity).filter((r) => this.matches(r, where)).length,
      ),
    ),
    existsBy: jest.fn((entity: Entity, where: Row) =>
      Promise.resolve(this.rows(entity).some((r) => this.matches(r, where))),
    ),
    create: jest.fn((entity: Entity, data: Row) => {
      const row = { ...data };
      Object.defineProperty(row, '__entity', { value: entity });
      return row;
    }),
    /** Inserts rows that are not stored yet; stored rows are already updated in place. */
    save: jest.fn((row: Row) => {
      this.guard();
      const entity = row.__entity as Entity | undefined;
      if (entity && !this.rows(entity).includes(row)) {
        row.id ??= `id-${++this.seq}`;
        this.rows(entity).push(row);
      }
      return Promise.resolve(row);
    }),
    remove: jest.fn((row: Row) => {
      for (const rows of this.tables.values()) {
        const index = rows.indexOf(row);
        if (index >= 0) rows.splice(index, 1);
      }
      return Promise.resolve(row);
    }),
    delete: jest.fn((entity: Entity, where: Row) => {
      const rows = this.rows(entity);
      this.tables.set(
        entity,
        rows.filter((r) => !this.matches(r, where)),
      );
      return Promise.resolve();
    }),
    insert: jest.fn((entity: Entity, values: Row[]) => {
      this.rows(entity).push(...values.map((v) => ({ ...v })));
      return Promise.resolve();
    }),
    query: jest.fn((_sql: string, [permission, action]: string[]) => {
      const holders = this.rows(UserRole as Entity).filter((ur) =>
        this.rows(RoleGrant as Entity).some((g) => {
          const p = this.rows(Permission as Entity).find(
            (x) => x.id === g.permissionId,
          );
          return (
            g.roleId === ur.roleId &&
            p?.name === permission &&
            p.actions.includes(action) &&
            (g.allActions || g.actions.includes(action))
          );
        }),
      );
      return Promise.resolve(holders.length ? [{ '?column?': 1 }] : []);
    }),
    createQueryBuilder: jest.fn(() => {
      const builder = {
        update: () => builder,
        set: () => builder,
        where: () => builder,
        returning: () => builder,
        execute: () => {
          this.version += 1;
          return Promise.resolve({ raw: [{ version: this.version }] });
        },
      };
      return builder;
    }),
  };

  dataSource = {
    manager: this.manager,
    transaction: jest.fn(async (work: (m: unknown) => Promise<unknown>) => {
      const before = [...this.tables].map(
        ([entity, rows]) =>
          [entity, rows.map((ref) => ({ ref, copy: { ...ref } }))] as const,
      );
      const versionBefore = this.version;
      try {
        return await work(this.manager);
      } catch (error) {
        // Restore the original row objects in place, as a rollback would.
        this.tables = new Map(
          before.map(([entity, saved]) => [
            entity,
            saved.map(({ ref, copy }) => {
              for (const key of Object.keys(ref)) delete ref[key];
              return Object.assign(ref, copy);
            }),
          ]),
        );
        this.version = versionBefore;
        throw error;
      }
    }),
  };

  private guard() {
    // Driver errors are plain objects carrying `driverError`, so throw them as they are.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (this.failWith) throw this.failWith;
  }
}

function build() {
  const db = new FakeDb();
  const snapshot = { reload: jest.fn().mockResolvedValue({}) };
  const service = new RbacAdminService(
    db.dataSource as never,
    snapshot as unknown as PolicySnapshotService,
  );
  return { service, db, snapshot };
}

/** An admin who holds rbac@manage through an all-actions grant. */
function withAdmin(db: FakeDb) {
  const permission = db.seed(Permission as Entity, {
    name: 'rbac',
    description: null,
    actions: ['manage'],
  });
  const role = db.seed(Role as Entity, { name: 'admin', description: null });
  const grant = db.seed(RoleGrant as Entity, {
    roleId: role.id,
    permissionId: permission.id,
    allActions: true,
    actions: [],
  });
  const user = db.seed(User as Entity, { email: 'admin@x.co' });
  db.seed(UserRole as Entity, { userId: user.id, roleId: role.id });
  return { permission, role, grant, user };
}

const ID = '00000000-0000-4000-8000-000000000000';

describe('RbacAdminService roles', () => {
  it('creates a role, bumps the version and reloads the snapshot', async () => {
    const { service, db, snapshot } = build();

    const role = await service.createRole({
      name: 'editor',
      description: '  Edits  ',
    });

    expect(role).toEqual({
      id: expect.any(String),
      name: 'editor',
      description: 'Edits',
    });
    expect(db.version).toBe(2);
    expect(snapshot.reload).toHaveBeenCalledTimes(1);
  });

  it('stores an empty description as null', async () => {
    const { service } = build();

    const role = await service.createRole({
      name: 'editor',
      description: '  ',
    });

    expect(role.description).toBeNull();
  });

  it('rejects a duplicate name (409) without bumping the version', async () => {
    const { service, db } = build();
    db.seed(Role as Entity, { name: 'editor', description: null });

    await expect(service.createRole({ name: 'editor' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(db.version).toBe(1);
  });

  it('maps a unique-constraint race to 409', async () => {
    const { service, db } = build();
    db.failWith = { driverError: { code: '23505' } };

    await expect(service.createRole({ name: 'editor' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('lists and gets roles', async () => {
    const { service, db } = build();
    const role = db.seed(Role as Entity, { name: 'a', description: null });

    await expect(service.listRoles()).resolves.toHaveLength(1);
    await expect(service.getRole(role.id)).resolves.toMatchObject({
      name: 'a',
    });
  });

  it('answers 404 for an unknown role', async () => {
    const { service } = build();

    await expect(service.getRole(ID)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.updateRole(ID, { name: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.deleteRole(ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('replaces a role and allows keeping its own name', async () => {
    const { service, db } = build();
    const role = db.seed(Role as Entity, { name: 'a', description: 'old' });

    const updated = await service.updateRole(role.id, {
      name: 'a',
      description: null,
    });

    expect(updated).toEqual({ id: role.id, name: 'a', description: null });
  });

  it('rejects renaming a role to another role’s name (409)', async () => {
    const { service, db } = build();
    db.seed(Role as Entity, { name: 'taken', description: null });
    const role = db.seed(Role as Entity, { name: 'a', description: null });

    await expect(
      service.updateRole(role.id, { name: 'taken' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to delete a role that has grants or users (409)', async () => {
    const { service, db } = build();
    const withGrant = db.seed(Role as Entity, { name: 'g', description: null });
    const withUser = db.seed(Role as Entity, { name: 'u', description: null });
    db.seed(RoleGrant as Entity, { roleId: withGrant.id });
    db.seed(UserRole as Entity, { userId: 'x', roleId: withUser.id });

    await expect(service.deleteRole(withGrant.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.deleteRole(withUser.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('deletes an unused role', async () => {
    const { service, db } = build();
    const role = db.seed(Role as Entity, { name: 'a', description: null });

    await service.deleteRole(role.id);

    expect(db.rows(Role as Entity)).toHaveLength(0);
    expect(db.version).toBe(2);
  });
});

describe('RbacAdminService permissions', () => {
  it('creates a permission with unique actions', async () => {
    const { service } = build();

    const permission = await service.createPermission({
      name: 'users',
      actions: ['read', 'update'],
    });

    expect(permission).toMatchObject({
      name: 'users',
      actions: ['read', 'update'],
    });
  });

  it('rejects duplicate actions (400)', async () => {
    const { service } = build();

    await expect(
      service.createPermission({ name: 'users', actions: ['read', 'read'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a duplicate permission name (409)', async () => {
    const { service, db } = build();
    db.seed(Permission as Entity, { name: 'users', actions: ['read'] });

    await expect(
      service.createPermission({ name: 'users', actions: ['read'] }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to remove an action used by an explicit grant (409)', async () => {
    const { service, db } = build();
    const permission = db.seed(Permission as Entity, {
      name: 'users',
      actions: ['read', 'update'],
    });
    db.seed(RoleGrant as Entity, {
      roleId: 'r',
      permissionId: permission.id,
      allActions: false,
      actions: ['update'],
    });

    await expect(
      service.updatePermission(permission.id, {
        name: 'users',
        actions: ['read'],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(permission.actions).toEqual(['read', 'update']);
  });

  it('lets all-actions grants follow a changed action list', async () => {
    const { service, db } = build();
    const permission = db.seed(Permission as Entity, {
      name: 'users',
      actions: ['read', 'update'],
    });
    db.seed(RoleGrant as Entity, {
      roleId: 'r',
      permissionId: permission.id,
      allActions: true,
      actions: [],
    });

    const updated = await service.updatePermission(permission.id, {
      name: 'users',
      actions: ['read', 'list'],
    });

    expect(updated.actions).toEqual(['read', 'list']);
  });

  it('refuses to delete a permission referenced by grants (409)', async () => {
    const { service, db } = build();
    const permission = db.seed(Permission as Entity, {
      name: 'users',
      actions: ['read'],
    });
    db.seed(RoleGrant as Entity, { permissionId: permission.id });

    await expect(
      service.deletePermission(permission.id),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('deletes an unreferenced permission and answers 404 for unknown ones', async () => {
    const { service, db } = build();
    const permission = db.seed(Permission as Entity, {
      name: 'users',
      actions: ['read'],
    });

    await service.deletePermission(permission.id);

    expect(db.rows(Permission as Entity)).toHaveLength(0);
    await expect(service.getPermission(ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.listPermissions()).resolves.toEqual([]);
  });
});

describe('RbacAdminService grants', () => {
  function seedPair(db: FakeDb) {
    const role = db.seed(Role as Entity, { name: 'editor', description: null });
    const permission = db.seed(Permission as Entity, {
      name: 'users',
      actions: ['read', 'update'],
    });
    return { role, permission };
  }

  it.each([[undefined], [[]]])(
    'treats actions=%j as all current and future actions',
    async (actions) => {
      const { service, db } = build();
      const { role, permission } = seedPair(db);

      const grant = await service.createGrant({
        roleId: role.id,
        permissionId: permission.id,
        actions,
      });

      expect(grant).toMatchObject({
        allActions: true,
        actions: ['read', 'update'],
      });
      expect(db.rows(RoleGrant as Entity)[0].actions).toEqual([]);
    },
  );

  it('creates an explicit grant', async () => {
    const { service, db } = build();
    const { role, permission } = seedPair(db);

    const grant = await service.createGrant({
      roleId: role.id,
      permissionId: permission.id,
      actions: ['read'],
    });

    expect(grant).toMatchObject({ allActions: false, actions: ['read'] });
  });

  it('rejects actions outside the permission and duplicates (400)', async () => {
    const { service, db } = build();
    const { role, permission } = seedPair(db);
    const base = { roleId: role.id, permissionId: permission.id };

    await expect(
      service.createGrant({ ...base, actions: ['purge'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createGrant({ ...base, actions: ['read', 'read'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a second grant for the same pair (409)', async () => {
    const { service, db } = build();
    const { role, permission } = seedPair(db);
    const dto = { roleId: role.id, permissionId: permission.id };
    await service.createGrant(dto);

    await expect(service.createGrant(dto)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('answers 404 for a missing role or permission', async () => {
    const { service, db } = build();
    const { role, permission } = seedPair(db);

    await expect(
      service.createGrant({ roleId: ID, permissionId: permission.id }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.createGrant({ roleId: role.id, permissionId: ID }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists, gets, replaces and deletes a grant', async () => {
    const { service, db } = build();
    const { role, permission } = seedPair(db);
    const created = await service.createGrant({
      roleId: role.id,
      permissionId: permission.id,
      actions: ['read'],
    });

    await expect(service.listGrants()).resolves.toEqual([created]);
    await expect(service.getGrant(created.id)).resolves.toEqual(created);

    const replaced = await service.updateGrant(created.id, {
      roleId: role.id,
      permissionId: permission.id,
    });
    expect(replaced).toMatchObject({ id: created.id, allActions: true });

    await service.deleteGrant(created.id);
    await expect(service.getGrant(created.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.deleteGrant(created.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('RbacAdminService user roles', () => {
  it('replaces the roles of a user and returns only ids', async () => {
    const { service, db } = build();
    const user = db.seed(User as Entity, { email: 'a@x.co' });
    const a = db.seed(Role as Entity, { name: 'a', description: null });
    const b = db.seed(Role as Entity, { name: 'b', description: null });
    db.seed(UserRole as Entity, { userId: user.id, roleId: a.id });

    const result = await service.setUserRoles(user.id, [b.id]);

    expect(result).toEqual({ userId: user.id, roleIds: [b.id] });
    await expect(service.getUserRoles(user.id)).resolves.toEqual(result);
  });

  it('allows an empty list, which removes all access', async () => {
    const { service, db } = build();
    const user = db.seed(User as Entity, { email: 'a@x.co' });
    const a = db.seed(Role as Entity, { name: 'a', description: null });
    db.seed(UserRole as Entity, { userId: user.id, roleId: a.id });

    await expect(service.setUserRoles(user.id, [])).resolves.toEqual({
      userId: user.id,
      roleIds: [],
    });
  });

  it('rejects duplicate and unknown role ids (400)', async () => {
    const { service, db } = build();
    const user = db.seed(User as Entity, { email: 'a@x.co' });
    const a = db.seed(Role as Entity, { name: 'a', description: null });

    await expect(
      service.setUserRoles(user.id, [a.id, a.id]),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.setUserRoles(user.id, [ID])).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('answers 404 for an unknown user', async () => {
    const { service } = build();

    await expect(service.getUserRoles(ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.setUserRoles(ID, [])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('RbacAdminService last rbac@manage holder', () => {
  it('refuses to delete the last holder’s grant (409) and rolls back', async () => {
    const { service, db } = build();
    const { grant } = withAdmin(db);

    await expect(service.deleteGrant(grant.id)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(db.rows(RoleGrant as Entity)).toHaveLength(1);
    expect(db.version).toBe(1);
  });

  it('refuses to empty the roles of the last holder (409)', async () => {
    const { service, db } = build();
    const { user, role } = withAdmin(db);

    await expect(service.setUserRoles(user.id, [])).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(db.rows(UserRole as Entity)).toEqual([
      expect.objectContaining({ userId: user.id, roleId: role.id }),
    ]);
  });

  it('refuses to drop manage from the permission when all-actions grants carry it', async () => {
    const { service, db } = build();
    const { permission } = withAdmin(db);

    await expect(
      service.updatePermission(permission.id, {
        name: 'rbac',
        actions: ['other'],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(permission.actions).toEqual(['manage']);
  });

  it('allows the change while another holder remains', async () => {
    const { service, db } = build();
    const { grant, role } = withAdmin(db);
    const second = db.seed(User as Entity, { email: 'two@x.co' });
    db.seed(UserRole as Entity, { userId: second.id, roleId: role.id });
    db.seed(User as Entity, { email: 'three@x.co' });
    const user = db.rows(User as Entity)[0];

    await expect(service.setUserRoles(user.id, [])).resolves.toMatchObject({
      roleIds: [],
    });
    expect(grant).toBeDefined();
  });

  it('does not block changes when nobody held the permission to begin with', async () => {
    const { service } = build();

    await expect(service.createRole({ name: 'first' })).resolves.toBeDefined();
  });
});

describe('RbacAdminService consistency', () => {
  it('rolls back data and version when the work fails midway', async () => {
    const { service, db } = build();
    const user = db.seed(User as Entity, { email: 'a@x.co' });
    const a = db.seed(Role as Entity, { name: 'a', description: null });
    db.manager.insert.mockRejectedValueOnce(new Error('insert failed'));

    await expect(service.setUserRoles(user.id, [a.id])).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(db.version).toBe(1);
    expect(db.rows(UserRole as Entity)).toHaveLength(0);
  });

  it('answers 503 when storage fails, for reads and writes', async () => {
    const { service, db } = build();
    db.failWith = new Error('connection lost');

    await expect(service.listRoles()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.createRole({ name: 'x' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('does not reload the snapshot when the change failed', async () => {
    const { service, snapshot } = build();

    await service.deleteRole(ID).catch(() => undefined);

    expect(snapshot.reload).not.toHaveBeenCalled();
  });

  it('still succeeds when the reload fails after commit', async () => {
    const { service, db, snapshot } = build();
    snapshot.reload.mockRejectedValue(new ServiceUnavailableException());

    await expect(service.createRole({ name: 'x' })).resolves.toMatchObject({
      name: 'x',
    });
    expect(db.version).toBe(2);
  });

  it('locks the policy version before changing anything', async () => {
    const { service, db } = build();

    await service.createRole({ name: 'x' });

    expect(db.manager.findOne.mock.calls[0][0]).toBe(PolicyState);
    expect(db.manager.findOne.mock.calls[0][1]).toMatchObject({
      lock: { mode: 'pessimistic_write' },
    });
  });
});
