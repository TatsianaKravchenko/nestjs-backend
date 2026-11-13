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

import { ConfirmationMethod } from '../../auth/entities/registration-attempt.entity';
import { User } from './user.entity';

export enum EmailChangeConsumedReason {
  CONFIRMED = 'confirmed',
  REPLACED = 'replaced',
  ATTEMPTS_EXHAUSTED = 'attempts_exhausted',
  USER_INACTIVE = 'user_inactive',
  /** An administrator set the email directly. */
  ADMIN_OVERRIDE = 'admin_override',
  /** The address was taken by someone else before the confirmation. */
  EMAIL_CONFLICT = 'email_conflict',
}

/**
 * Pending change of the user's own email. A user has at most one unconsumed
 * challenge (partial unique index). The secret expires 10 minutes after
 * `lastSentAt`. Only the HMAC of the secret is stored.
 */
@Entity('email_change_challenges')
@Index('UQ_email_change_challenges_open_per_user', ['userId'], {
  unique: true,
  where: '"consumed_at" IS NULL',
})
export class EmailChangeChallenge {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  /** Normalized address the secret is sent to. Never logged. */
  @Column({ name: 'new_email', type: 'varchar', length: 320 })
  newEmail!: string;

  @Column({
    type: 'enum',
    enum: ConfirmationMethod,
  })
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
    enum: EmailChangeConsumedReason,
    nullable: true,
  })
  consumedReason!: EmailChangeConsumedReason | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
