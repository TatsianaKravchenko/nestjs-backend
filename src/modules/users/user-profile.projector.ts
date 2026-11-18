import { UserProfileDto } from './dto/user-profile.dto';
import { User, UserStatus } from './entities/user.entity';

/** Columns the profile query may read. Nothing else is ever selected. */
export type ProfileRow = Pick<
  User,
  | 'id'
  | 'email'
  | 'displayName'
  | 'photoKey'
  | 'status'
  | 'createdAt'
  | 'updatedAt'
>;

/** Columns the photo query may read. */
export type PhotoRow = Pick<User, 'id' | 'status' | 'photoKey'>;

/** A photo is served only for a user that has a key and is not being deleted. */
export function hasServablePhoto(
  row: Pick<User, 'status' | 'photoKey'>,
): boolean {
  return (
    !!row.photoKey &&
    row.status !== UserStatus.DELETING &&
    row.status !== UserStatus.DELETED
  );
}

/** API URL of the protected photo endpoint; built from the id only, no storage call. */
export function photoUrlFor(userId: string, publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}/users/${encodeURIComponent(userId)}/photo`;
}

/**
 * Explicit allow-list projection. Every response field is copied by name, so a
 * column added to the entity later does not leak unless it is added here.
 */
export function toUserProfile(
  row: ProfileRow,
  publicBaseUrl: string,
): UserProfileDto {
  const dto = new UserProfileDto();
  dto.id = row.id;
  dto.email = row.email;
  dto.displayName = row.displayName ?? null;
  dto.photoUrl = hasServablePhoto(row)
    ? photoUrlFor(row.id, publicBaseUrl)
    : null;
  dto.status = row.status;
  dto.createdAt = row.createdAt.toISOString();
  dto.updatedAt = row.updatedAt.toISOString();
  return dto;
}
