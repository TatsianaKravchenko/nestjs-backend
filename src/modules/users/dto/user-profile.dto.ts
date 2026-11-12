import { ApiProperty } from '@nestjs/swagger';

import { UserStatus } from '../entities/user.entity';

/**
 * The only shape in which a user leaves the service. Self, foreign and admin
 * views are identical. Built field by field by `toUserProfile`, so no column
 * that is not listed here (password hash, photo key, ...) can ever be serialized.
 */
export class UserProfileDto {
  @ApiProperty({ example: '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44' })
  id!: string;

  @ApiProperty({ example: 'jane@example.com', description: 'Not masked.' })
  email!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Jane Doe' })
  displayName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'API URL of the protected photo endpoint; null without a photo or for deleting/deleted users.',
    example: 'https://api.example.com/users/3f2b9c1e/photo',
  })
  photoUrl!: string | null;

  @ApiProperty({ enum: UserStatus, example: UserStatus.ACTIVE })
  status!: UserStatus;

  @ApiProperty({ format: 'date-time', example: '2026-01-01T00:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', example: '2026-01-01T00:00:00.000Z' })
  updatedAt!: string;
}
