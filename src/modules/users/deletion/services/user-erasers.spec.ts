/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  bumpPolicyVersion,
  lockPolicyVersion,
} from '@/modules/rbac/policy-version';

import type { PhotoStorage } from '../../storage/photo-storage';
import { UserEraserRegistry } from './user-eraser.registry';
import {
  ChallengeEraser,
  deleteChallenges,
  PhotoEraser,
  RoleEraser,
} from './user-erasers';

jest.mock('@/modules/rbac/policy-version');

const USER_ID = '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44';

describe('PhotoEraser', () => {
  const findOne = jest.fn();
  const dataSource = { getRepository: () => ({ findOne }) };
  const storage = { delete: jest.fn() };
  const registry = new UserEraserRegistry();
  const eraser = new PhotoEraser(
    dataSource as never,
    registry,
    storage as unknown as PhotoStorage,
  );

  beforeEach(() => jest.resetAllMocks());

  it('registers itself under its store on init', () => {
    eraser.onModuleInit();
    expect(registry.all()).toContain(eraser);
    expect(eraser.store).toBe('users.photo');
  });

  it('succeeds without a lookup for a non-uuid id', async () => {
    await expect(eraser.erase('nope')).resolves.toEqual({
      status: 'succeeded',
    });
    expect(findOne).not.toHaveBeenCalled();
  });

  it('succeeds when the user has no photo', async () => {
    findOne.mockResolvedValue({ photoKey: null });
    await expect(eraser.erase(USER_ID)).resolves.toEqual({
      status: 'succeeded',
    });
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('succeeds when the user is unknown', async () => {
    findOne.mockResolvedValue(null);
    await expect(eraser.erase(USER_ID)).resolves.toEqual({
      status: 'succeeded',
    });
  });

  it.each(['deleted', 'not_found'])(
    'treats %s as success after deleting the object',
    async (result) => {
      findOne.mockResolvedValue({ photoKey: 'k.webp' });
      storage.delete.mockResolvedValue(result);
      await expect(eraser.erase(USER_ID)).resolves.toEqual({
        status: 'succeeded',
      });
      expect(storage.delete).toHaveBeenCalledWith('k.webp');
    },
  );

  it('is a retryable failure while the storage is unavailable', async () => {
    findOne.mockResolvedValue({ photoKey: 'k.webp' });
    storage.delete.mockResolvedValue('unavailable');
    await expect(eraser.erase(USER_ID)).resolves.toEqual({
      status: 'retryable_failure',
      code: 'storage_unavailable',
    });
  });
});

describe('deleteChallenges / ChallengeEraser', () => {
  const query = jest.fn();

  beforeEach(() => jest.resetAllMocks());

  it('deletes the rows of all four challenge tables of the user', async () => {
    await deleteChallenges({ query }, USER_ID);
    const tables = query.mock.calls.map(
      (call) => (call[0] as string).split(' ')[2],
    );
    expect(tables).toEqual([
      'registration_attempts',
      'login_attempts',
      'email_change_challenges',
      'deletion_challenges',
    ]);
    for (const call of query.mock.calls) expect(call[1]).toEqual([USER_ID]);
  });

  it('runs inside one transaction and registers itself', async () => {
    const registry = new UserEraserRegistry();
    const dataSource = {
      transaction: jest.fn((work: (m: unknown) => Promise<void>) =>
        work({ query }),
      ),
    };
    const eraser = new ChallengeEraser(dataSource as never, registry);
    eraser.onModuleInit();

    await expect(eraser.erase(USER_ID)).resolves.toEqual({
      status: 'succeeded',
    });
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(4);
    expect(registry.all()).toContain(eraser);
  });
});

describe('RoleEraser', () => {
  const execute = jest.fn();
  const where = jest.fn(() => ({ execute }));
  const manager = {
    createQueryBuilder: () => ({
      delete: () => ({ from: () => ({ where }) }),
    }),
  };
  const dataSource = { transaction: jest.fn() };
  const registry = new UserEraserRegistry();
  const eraser = new RoleEraser(dataSource as never, registry);

  beforeEach(() => {
    jest.resetAllMocks();
    where.mockImplementation(() => ({ execute }));
    dataSource.transaction.mockImplementation(
      (work: (m: unknown) => Promise<void>) => work(manager),
    );
  });

  it('locks the policy, removes the roles and bumps the version when some existed', async () => {
    execute.mockResolvedValue({ affected: 2 });
    await expect(eraser.erase(USER_ID)).resolves.toEqual({
      status: 'succeeded',
    });
    expect(lockPolicyVersion).toHaveBeenCalledWith(manager);
    expect(where).toHaveBeenCalledWith('user_id = :userId', {
      userId: USER_ID,
    });
    expect(bumpPolicyVersion).toHaveBeenCalledWith(manager);
  });

  it.each([0, undefined])(
    'does not bump the version when %s rows were removed',
    async (affected) => {
      execute.mockResolvedValue({ affected });
      await eraser.erase(USER_ID);
      expect(bumpPolicyVersion).not.toHaveBeenCalled();
    },
  );

  it('registers itself under its store on init', () => {
    eraser.onModuleInit();
    expect(registry.all()).toContain(eraser);
    expect(eraser.store).toBe('rbac.roles');
  });
});
