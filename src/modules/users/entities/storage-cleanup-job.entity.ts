import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum StorageCleanupStatus {
  QUEUED = 'queued',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
}

export enum StorageCleanupReason {
  PHOTO_REPLACED = 'photo_replaced',
  PHOTO_CLEARED = 'photo_cleared',
}

/** Total delivery attempts of a job before it becomes `failed`. */
export const CLEANUP_MAX_ATTEMPTS = 5;
export const CLEANUP_RETRY_DELAY_MS = 60_000;

/**
 * An object that no longer belongs to any profile and must be deleted from
 * storage. Written in the same transaction that drops the reference, so the
 * deletion is never lost. The object key is only read by the worker; logs use
 * the job id.
 */
@Entity('storage_cleanup_jobs')
@Index('IDX_storage_cleanup_jobs_due', ['status', 'nextAttemptAt'])
export class StorageCleanupJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'object_key', type: 'varchar', length: 512 })
  objectKey!: string;

  @Column({
    type: 'enum',
    enum: StorageCleanupReason,
  })
  reason!: StorageCleanupReason;

  @Column({
    type: 'enum',
    enum: StorageCleanupStatus,
    default: StorageCleanupStatus.QUEUED,
  })
  status!: StorageCleanupStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz' })
  nextAttemptAt!: Date;

  /** Short machine code of the last failure; never a message or a path. */
  @Column({
    name: 'last_error_code',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  lastErrorCode!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
