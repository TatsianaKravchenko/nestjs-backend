import { Permission } from '@/modules/rbac/entities/permission.entity';
import { Role } from '@/modules/rbac/entities/role.entity';

import { TransformationsReadinessIndicator } from './transformations.health';

describe('TransformationsReadinessIndicator', () => {
  const session = {
    up: jest.fn((data?: object) => ({
      transformations: { status: 'up', ...data },
    })),
    down: jest.fn((data?: object) => ({
      transformations: { status: 'down', ...data },
    })),
  };
  const indicators = { check: jest.fn(() => session) };
  const existsBy = jest.fn();
  const temp = { probe: jest.fn() };
  const indicator = new TransformationsReadinessIndicator(
    indicators as never,
    { manager: { existsBy } } as never,
    temp as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    existsBy.mockResolvedValue(true);
    temp.probe.mockResolvedValue(true);
  });

  it('is up when the user role, the permission and the temp area are there', async () => {
    await expect(indicator.check()).resolves.toEqual({
      transformations: { status: 'up' },
    });
    expect(existsBy).toHaveBeenCalledWith(Role, { name: 'user' });
    expect(existsBy).toHaveBeenCalledWith(Permission, {
      name: 'transformations',
    });
  });

  it('is down when the user role is missing', async () => {
    existsBy.mockImplementation((type: unknown) =>
      Promise.resolve(type !== Role),
    );

    const result = await indicator.check();

    expect(result.transformations.status).toBe('down');
    expect(session.down).toHaveBeenCalledWith({
      message: 'The default user role is missing',
    });
    expect(temp.probe).not.toHaveBeenCalled();
  });

  it('is down when the permission is not registered', async () => {
    existsBy.mockImplementation((type: unknown) =>
      Promise.resolve(type !== Permission),
    );

    await indicator.check();

    expect(session.down).toHaveBeenCalledWith({
      message: 'The transformations permission is not registered',
    });
  });

  it('is down when the temp area is not writable', async () => {
    temp.probe.mockResolvedValue(false);

    await indicator.check();

    expect(session.down).toHaveBeenCalledWith({
      message: 'The temporary area is not writable',
    });
  });

  it('is down, not an error, when the database fails', async () => {
    existsBy.mockRejectedValue(new Error('down'));

    await indicator.check('custom');

    expect(indicators.check).toHaveBeenCalledWith('custom');
    expect(session.down).toHaveBeenCalledWith({
      message: 'Policy data is unavailable',
    });
  });
});
