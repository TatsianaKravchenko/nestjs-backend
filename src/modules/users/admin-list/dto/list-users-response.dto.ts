import { ApiProperty } from '@nestjs/swagger';

import { UserProfileDto } from '../../dto/user-profile.dto';

export class ListUsersResponseDto {
  @ApiProperty({ type: [UserProfileDto] })
  items!: UserProfileDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Opaque signed cursor for the next page (valid 15 minutes from the first page); null on the last page. No total count is ever returned.',
  })
  nextCursor!: string | null;
}
