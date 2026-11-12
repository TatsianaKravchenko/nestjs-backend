import type { Repository } from 'typeorm';

import { User } from './entities/user.entity';
import { UsersService } from './users.service';

const UUID = '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44';

describe('UsersService profile reads', () => {
  const findOne = jest.fn();
  const service = new UsersService({ findOne } as unknown as Repository<User>);

  beforeEach(() => findOne.mockReset());

  it('selects only the allow-listed profile columns', async () => {
    findOne.mockResolvedValue({ id: UUID });

    await service.findProfile(UUID);

    expect(findOne).toHaveBeenCalledWith({
      where: { id: UUID },
      select: {
        id: true,
        email: true,
        displayName: true,
        photoKey: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });

  it('selects only id, status and photo key for the photo', async () => {
    findOne.mockResolvedValue(null);

    await service.findPhotoRef(UUID);

    expect(findOne).toHaveBeenCalledWith({
      where: { id: UUID },
      select: { id: true, status: true, photoKey: true },
    });
  });

  it('never queries for an id that is not a uuid', async () => {
    await expect(service.findProfile('not-a-uuid')).resolves.toBeNull();
    await expect(service.findPhotoRef('not-a-uuid')).resolves.toBeNull();

    expect(findOne).not.toHaveBeenCalled();
  });

  it('keeps the auth state query minimal', async () => {
    findOne.mockResolvedValue({ id: UUID, status: 'active' });

    await service.findAuthState(UUID);

    expect(findOne).toHaveBeenCalledWith({
      where: { id: UUID },
      select: { id: true, status: true },
    });
  });

  it('normalizes emails', () => {
    expect(UsersService.normalizeEmail('  A@B.Com ')).toBe('a@b.com');
  });
});
