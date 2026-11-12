import { User, UserStatus } from './entities/user.entity';
import {
  hasServablePhoto,
  ProfileRow,
  toUserProfile,
} from './user-profile.projector';

const row = (over: Partial<ProfileRow> = {}): ProfileRow => ({
  id: 'u-1',
  email: 'jane@example.com',
  displayName: 'Jane',
  photoKey: 'photos/secret-key.webp',
  status: UserStatus.ACTIVE,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  ...over,
});

describe('toUserProfile', () => {
  it('returns exactly the allow-listed fields', () => {
    const profile = toUserProfile(row(), 'https://api.example.com');

    expect(Object.keys(profile).sort()).toEqual(
      [
        'createdAt',
        'displayName',
        'email',
        'id',
        'photoUrl',
        'status',
        'updatedAt',
      ].sort(),
    );
    expect(profile).toMatchObject({
      id: 'u-1',
      email: 'jane@example.com',
      displayName: 'Jane',
      photoUrl: 'https://api.example.com/users/u-1/photo',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('never leaks internal columns, even if the source object carries them', () => {
    const dirty = {
      ...row(),
      passwordHash: '$argon2id$secret',
      password_hash: '$argon2id$secret',
    } as ProfileRow & Partial<User>;

    const json = JSON.stringify(
      toUserProfile(dirty, 'https://api.example.com'),
    );

    expect(json).not.toMatch(/argon2|passwordHash|password_hash/i);
    expect(json).not.toMatch(/photoKey|photo_key|secret-key/i);
  });

  it('trims a trailing slash of the base url and encodes the id', () => {
    expect(
      toUserProfile(row({ id: 'a-b_c' }), 'https://api.example.com//').photoUrl,
    ).toBe('https://api.example.com/users/a-b_c/photo');
  });

  it('uses null for a missing display name and photo', () => {
    const profile = toUserProfile(
      row({ displayName: null, photoKey: null }),
      'https://x.test',
    );

    expect(profile.displayName).toBeNull();
    expect(profile.photoUrl).toBeNull();
  });

  it.each([UserStatus.DELETING, UserStatus.DELETED])(
    'hides the photo url for a %s user',
    (status) => {
      expect(
        toUserProfile(row({ status }), 'https://x.test').photoUrl,
      ).toBeNull();
    },
  );

  it.each([
    UserStatus.PENDING,
    UserStatus.ACTIVE,
    UserStatus.BLOCKED,
    UserStatus.DELETING,
    UserStatus.DELETED,
  ])('reports the %s status as is', (status) => {
    expect(toUserProfile(row({ status }), 'https://x.test').status).toBe(
      status,
    );
  });
});

describe('hasServablePhoto', () => {
  it.each([
    [UserStatus.PENDING, 'k', true],
    [UserStatus.ACTIVE, 'k', true],
    [UserStatus.BLOCKED, 'k', true],
    [UserStatus.DELETING, 'k', false],
    [UserStatus.DELETED, 'k', false],
    [UserStatus.ACTIVE, null, false],
    [UserStatus.ACTIVE, '', false],
  ])('%s with key %p -> %p', (status, photoKey, expected) => {
    expect(hasServablePhoto({ status, photoKey })).toBe(expected);
  });
});
