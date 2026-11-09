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

import { User } from '../../users/entities/user.entity';
import { ConfirmationMethod } from './registration-attempt.entity';

export enum LoginAttemptConsumedReason {
  CONFIRMED = 'confirmed',
  REPLACED = 'replaced',
  ATTEMPTS_EXHAUSTED = 'attempts_exhausted',
  USER_INACTIVE = 'user_inactive',
}

/**
 * The email challenge of a login. A user has at most one unconsumed attempt
 * (partial unique index). The code/link expires 10 minutes after `lastSentAt`.
 */
@Entity('login_attempts')
@Index('UQ_login_attempts_open_per_user', ['userId'], {
  unique: true,
  where: '"consumed_at" IS NULL',
})
export class LoginAttempt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'enum', enum: ConfirmationMethod })
  method!: ConfirmationMethod;

  /** HMAC-SHA256 (hex) of the OTP code or magic-link secret. The secret itself is never stored. */
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
    enum: LoginAttemptConsumedReason,
    nullable: true,
  })
  consumedReason!: LoginAttemptConsumedReason | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
