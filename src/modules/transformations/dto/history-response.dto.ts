import { ApiProperty } from '@nestjs/swagger';

import {
  StorageStatus,
  TransformationStatus,
  TransformationType,
} from '../entities/transformation.entity';

/**
 * One attempt. Metadata only: no user id, e-mail, file name, contents, storage
 * key, path, bucket or internal storage error code.
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

  @ApiProperty({
    enum: StorageStatus,
    description:
      '`not_requested` without `save=true` (and after an expired file was removed), `pending` while the copy is being stored, `available`, or `error`.',
  })
  storageStatus!: StorageStatus;

  @ApiProperty({
    example: false,
    description:
      'True only when the file is `available` and can be downloaded.',
  })
  hasStoredFile!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description: 'When the stored file is removed; null unless `available`.',
  })
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
