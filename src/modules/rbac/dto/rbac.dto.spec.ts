import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { GrantDto } from './grant.dto';
import { PermissionDto } from './permission.dto';
import { RoleDto } from './role.dto';
import { UserRolesDto } from './user-roles.dto';

const UUID = '00000000-0000-4000-8000-000000000000';

async function check<T extends object>(
  type: new () => T,
  plain: object,
): Promise<{ errors: string[]; value: T }> {
  const value = plainToInstance(type, plain);
  const errors = await validate(value, { whitelist: true });
  return { errors: errors.map((e) => e.property), value };
}

describe('RoleDto', () => {
  it('trims and lowercases the name', async () => {
    const { errors, value } = await check(RoleDto, { name: '  Editor ' });

    expect(errors).toEqual([]);
    expect(value.name).toBe('editor');
  });

  it.each(['', '1admin', 'has space', 'x'.repeat(65), 'ümlaut'])(
    'rejects the invalid name %j',
    async (name) => {
      expect((await check(RoleDto, { name })).errors).toContain('name');
    },
  );

  it('accepts the longest name of 64 characters', async () => {
    expect((await check(RoleDto, { name: 'a'.repeat(64) })).errors).toEqual([]);
  });

  it('turns an empty description into null and rejects a long one', async () => {
    const empty = await check(RoleDto, { name: 'a', description: '   ' });
    expect(empty.errors).toEqual([]);
    expect(empty.value.description).toBeNull();

    const long = await check(RoleDto, {
      name: 'a',
      description: 'x'.repeat(501),
    });
    expect(long.errors).toContain('description');
  });

  it('rejects a non-string name', async () => {
    expect((await check(RoleDto, { name: 5 })).errors).toContain('name');
  });
});

describe('PermissionDto', () => {
  it('normalizes the name and the actions', async () => {
    const { errors, value } = await check(PermissionDto, {
      name: ' Users',
      actions: [' Read ', 'UPDATE'],
    });

    expect(errors).toEqual([]);
    expect(value.name).toBe('users');
    expect(value.actions).toEqual(['read', 'update']);
  });

  it('requires 1 to 64 actions', async () => {
    expect(
      (await check(PermissionDto, { name: 'users', actions: [] })).errors,
    ).toContain('actions');

    const many = Array.from({ length: 65 }, (_, i) => `a${i}`);
    expect(
      (await check(PermissionDto, { name: 'users', actions: many })).errors,
    ).toContain('actions');

    const max = Array.from({ length: 64 }, (_, i) => `a${i}`);
    expect(
      (await check(PermissionDto, { name: 'users', actions: max })).errors,
    ).toEqual([]);
  });

  it('rejects invalid action values and non-arrays', async () => {
    expect(
      (await check(PermissionDto, { name: 'users', actions: ['bad action'] }))
        .errors,
    ).toContain('actions');
    expect(
      (await check(PermissionDto, { name: 'users', actions: 'read' })).errors,
    ).toContain('actions');
  });
});

describe('GrantDto', () => {
  it('accepts ids without actions', async () => {
    expect(
      (await check(GrantDto, { roleId: UUID, permissionId: UUID })).errors,
    ).toEqual([]);
  });

  it('normalizes actions', async () => {
    const { value } = await check(GrantDto, {
      roleId: UUID,
      permissionId: UUID,
      actions: ['READ'],
    });

    expect(value.actions).toEqual(['read']);
  });

  it('rejects malformed ids and actions', async () => {
    const { errors } = await check(GrantDto, {
      roleId: 'nope',
      permissionId: 5,
      actions: ['bad action'],
    });

    expect(errors).toEqual(
      expect.arrayContaining(['roleId', 'permissionId', 'actions']),
    );
  });
});

describe('UserRolesDto', () => {
  it('accepts a list of ids and an empty list', async () => {
    expect((await check(UserRolesDto, { roleIds: [UUID] })).errors).toEqual([]);
    expect((await check(UserRolesDto, { roleIds: [] })).errors).toEqual([]);
  });

  it('rejects a missing list and malformed ids', async () => {
    expect((await check(UserRolesDto, {})).errors).toContain('roleIds');
    expect((await check(UserRolesDto, { roleIds: ['x'] })).errors).toContain(
      'roleIds',
    );
  });
});
