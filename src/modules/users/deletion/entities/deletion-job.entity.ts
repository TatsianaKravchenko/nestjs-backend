import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../entities/user.entity';

export enum DeletionJobStatus {
  QUEUED = 'queued',
  RUNNING = 'running',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
}

/** Total runs of a job before it becomes `failed`. */
export const DELETION_MAX_ATTEMPTS = 5;
export const DELETION_RETRY_DELAY_MS = 60_000;
/** 32 lowercase hex characters: the `Idempotency-Key` and the status receipt. */
export const JOB_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Durable account deletion. One job per user (unique `user_id`). `id` is the
 * job id the client knows: the `Idempotency-Key` of a self deletion, random
 * for an administrator. The tombstone email replaces the address on
 * finalization and is fixed at creation so a retry cannot change it.
 */
@Entity('deletion_jobs')
@Index('IDX_deletion_jobs_due', ['status', 'nextAttemptAt'])
export class DeletionJob {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  id!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Index('UQ_deletion_jobs_user', { unique: true })
  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({
    type: 'enum',
    enum: DeletionJobStatus,
    default: DeletionJobStatus.QUEUED,
  })
  status!: DeletionJobStatus;

  @Index('UQ_deletion_jobs_tombstone', { unique: true })
  @Column({ name: 'tombstone_email', type: 'varchar', length: 320 })
  tombstoneEmail!: string;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ name: 'lease_until', type: 'timestamptz', nullable: true })
  leaseUntil!: Date | null;

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
