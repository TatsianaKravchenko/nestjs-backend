import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';

export enum TransformationType {
  FILE = 'file',
  IMAGE = 'image',
}

export enum TransformationStatus {
  SUCCESS = 'success',
  ERROR = 'error',
}

/**
 * Whether a `save=true` result is kept in permanent storage. `not_requested`
 * is also the state after the retention cleanup removed an expired file.
 */
export enum StorageStatus {
  NOT_REQUESTED = 'not_requested',
  /** Staged under `stored_file_key`; the background upload has not finished. */
  PENDING = 'pending',
  AVAILABLE = 'available',
  ERROR = 'error',
}

const bigintAsNumber = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

/**
 * One attempt of a file transformation (BCNF: every column depends on `id`
 * only). Metadata only: never file contents, names, paths, the user's email or
 * library messages. `error_code` is a short safe code. A row is written for
 * every attempt that reached a converter, so `completed_at` is always set.
 */
@Entity('transformations')
@Index('IDX_transformations_user_created_id', ['userId', 'createdAt', 'id'])
// Retention cleanup selects by `created_at` alone, across all users.
@Index('IDX_transformations_created_at', ['createdAt'])
@Check('CHK_transformations_sizes', '"input_size" >= 0 AND "duration_ms" >= 0')
@Check(
  'CHK_transformations_outcome',
  `("status" = 'success' AND "output_size" IS NOT NULL AND "output_size" >= 0 AND "error_code" IS NULL) OR ("status" = 'error' AND "output_size" IS NULL AND "error_code" IS NOT NULL)`,
)
// The upload worker selects `pending` rows; the retention cleanup selects
// `available` rows by `stored_file_until`.
@Index('IDX_transformations_storage_status', ['storageStatus'])
@Index('IDX_transformations_stored_file_until', ['storedFileUntil'])
@Check(
  'CHK_transformations_storage',
  `("storage_status" = 'not_requested' AND "stored_file_key" IS NULL AND "stored_file_until" IS NULL AND "storage_error_code" IS NULL) OR ("storage_status" = 'pending' AND "stored_file_key" IS NOT NULL AND "stored_file_until" IS NULL AND "storage_error_code" IS NULL) OR ("storage_status" = 'available' AND "stored_file_key" IS NOT NULL AND "stored_file_until" IS NOT NULL AND "storage_error_code" IS NULL) OR ("storage_status" = 'error' AND "stored_file_until" IS NULL AND "storage_error_code" IS NOT NULL)`,
)
export class Transformation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'enum', enum: TransformationType })
  type!: TransformationType;

  @Column({ name: 'source_format', type: 'varchar', length: 32 })
  sourceFormat!: string;

  @Column({ name: 'target_format', type: 'varchar', length: 32 })
  targetFormat!: string;

  @Column({ type: 'enum', enum: TransformationStatus })
  status!: TransformationStatus;

  @Column({
    name: 'input_size',
    type: 'bigint',
    transformer: bigintAsNumber,
  })
  inputSize!: number;

  @Column({
    name: 'output_size',
    type: 'bigint',
    nullable: true,
    transformer: bigintAsNumber,
  })
  outputSize!: number | null;

  @Column({ name: 'duration_ms', type: 'int' })
  durationMs!: number;

  @Column({ name: 'error_code', type: 'varchar', length: 64, nullable: true })
  errorCode!: string | null;

  /** Start of the attempt (UTC). Set by the service, not by the database. */
  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz' })
  completedAt!: Date;

  @Column({
    name: 'storage_status',
    type: 'enum',
    enum: StorageStatus,
    default: StorageStatus.NOT_REQUESTED,
  })
  storageStatus!: StorageStatus;

  /** Random server-generated key (no user id, e-mail or file name); never exposed. */
  @Column({
    name: 'stored_file_key',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  storedFileKey!: string | null;

  @Column({ name: 'stored_file_until', type: 'timestamptz', nullable: true })
  storedFileUntil!: Date | null;

  /** Short safe code of the last storage failure; never exposed. */
  @Column({
    name: 'storage_error_code',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  storageErrorCode!: string | null;
}
