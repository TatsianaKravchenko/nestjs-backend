import {
  Column,
  CreateDateColumn,
  Entity,
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
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Normalized (trimmed, lowercased) email. Uniqueness is enforced by the database. */
  @Column({ type: 'varchar', length: 320, unique: true })
  email!: string;

  /** Argon2id hash (the salt is embedded in the encoded string). */
  @Column({ name: 'password_hash', type: 'varchar', length: 255 })
  passwordHash!: string;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.PENDING })
  status!: UserStatus;

  /** NFC-normalized, 1-80 code points, no control characters. */
  @Column({
    name: 'display_name',
    type: 'varchar',
    length: 320,
    nullable: true,
  })
  displayName!: string | null;

  /** Internal object-storage key of the photo. Never leaves the service. */
  @Column({ name: 'photo_key', type: 'varchar', length: 512, nullable: true })
  photoKey!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
