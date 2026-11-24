import { ApiProperty } from '@nestjs/swagger';

import {
  TransformationStatus,
  TransformationType,
} from '../entities/transformation.entity';

/**
 * One attempt. Metadata only: no user id, e-mail, file name, contents or
 * storage key. The three storage fields are fixed until the object storage
 * integration (task 2.4) fills them.
 */
export class TransformationHistoryItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: TransformationType })
  type!: TransformationType;

  @ApiProperty({ example: 'csv' })
  sourceFormat!: string;

  @ApiProperty({ example: 'json' })
  targetFormat!: string;

  @ApiProperty({ enum: TransformationStatus })
  status!: TransformationStatus;

  @ApiProperty({ description: 'Bytes.' })
  inputSize!: number;

  @ApiProperty({ type: Number, nullable: true, description: 'Bytes.' })
  outputSize!: number | null;

  @ApiProperty()
  durationMs!: number;

  @ApiProperty({ type: String, nullable: true })
  errorCode!: string | null;

  @ApiProperty({ format: 'date-time', description: 'UTC.' })
  createdAt!: string;

  @ApiProperty({ enum: ['not_requested'] })
  storageStatus!: 'not_requested';

  @ApiProperty({ example: false })
  hasStoredFile!: false;

  @ApiProperty({ type: String, nullable: true, example: null })
  fileExpiresAt!: string | null;
}

export class TransformationHistoryResponseDto {
  @ApiProperty({ type: [TransformationHistoryItemDto] })
  items!: TransformationHistoryItemDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Opaque cursor for the next page; null on the last page. Send it back with the same `limit` and filters. No total count is returned.',
  })
  nextCursor!: string | null;
}
