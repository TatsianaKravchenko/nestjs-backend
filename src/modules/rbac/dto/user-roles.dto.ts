import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';

export class UserRolesDto {
  @ApiProperty({
    type: [String],
    description: 'The complete list of role ids; an empty list removes access.',
  })
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  roleIds!: string[];
}
