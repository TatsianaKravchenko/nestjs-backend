import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum UserStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  BLOCKED = 'blocked',
  /** Deletion was accepted; tokens already stop working. */
  DELETING = 'deleting',
  /** Cleanup and anonymization are complete. */
  DELETED = 'deleted',
}

@Entity('users')
@Check(
  'CHK_users_display_name',
  `"display_name" IS NULL OR ("display_name" IS NFC NORMALIZED AND char_length("display_name") BETWEEN 1 AND 80)`,
)
@Check(
  'CHK_users_password_hash_required',
  `"password_hash" IS NOT NULL OR "status" = 'deleted'`,
)
@Check(
  'CHK_users_deleted_erased',
  `"status" <> 'deleted' OR ("display_name" IS NULL AND "photo_key" IS NULL)`,
)
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Normalized (trimmed, lowercased) email. Uniqueness is enforced by the database. */
  @Column({ type: 'varchar', length: 320, unique: true })
  email!: string;

  /**
   * Argon2id hash (the salt is embedded in the encoded string). Null only
   * after the deletion was finalized (`status = deleted`), enforced by a CHECK.
   */
  @Column({
    name: 'password_hash',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  passwordHash!: string | null;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.PENDING })
  status!: UserStatus;

  /** NFC-normalized, 1-80 code points, no control characters. */
  @Column({
    name: 'display_name',
    type: 'varchar',
    length: 80,
    nullable: true,
  })
  displayName!: string | null;

  /** Internal object-storage key of the photo. Never leaves the service. */
  @Index('UQ_users_photo_key', { unique: true })
  @Column({ name: 'photo_key', type: 'varchar', length: 512, nullable: true })
  photoKey!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
