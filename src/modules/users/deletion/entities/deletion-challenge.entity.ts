import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { ConfirmationMethod } from '../../../auth/entities/registration-attempt.entity';
import { User } from '../../entities/user.entity';

export enum DeletionChallengeConsumedReason {
  CONFIRMED = 'confirmed',
  REPLACED = 'replaced',
  ATTEMPTS_EXHAUSTED = 'attempts_exhausted',
  USER_INACTIVE = 'user_inactive',
  /** A deletion job already existed for the user. */
  JOB_EXISTS = 'job_exists',
}

/**
 * Pending confirmation of the user's own account deletion. A user has at most
 * one unconsumed challenge (partial unique index). The secret expires 10
 * minutes after `lastSentAt`. Only the HMAC of the secret is stored.
 */
@Entity('deletion_challenges')
@Index('UQ_deletion_challenges_open_per_user', ['userId'], {
  unique: true,
  where: '"consumed_at" IS NULL',
})
export class DeletionChallenge {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'enum', enum: ConfirmationMethod })
  method!: ConfirmationMethod;

  /** HMAC-SHA256 (hex) of the OTP or the link secret, bound to the challenge id. */
  @Column({ name: 'secret_hash', type: 'varchar', length: 64 })
  secretHash!: string;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ name: 'last_sent_at', type: 'timestamptz' })
  lastSentAt!: Date;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;

  @Column({
    name: 'consumed_reason',
    type: 'enum',
    enum: DeletionChallengeConsumedReason,
    nullable: true,
  })
  consumedReason!: DeletionChallengeConsumedReason | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
