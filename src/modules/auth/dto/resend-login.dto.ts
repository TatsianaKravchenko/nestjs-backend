import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class ResendLoginDto {
  @ApiProperty()
  @IsUUID()
  attemptId!: string;
}
