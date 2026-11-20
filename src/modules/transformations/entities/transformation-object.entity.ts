import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Transformation } from './transformation.entity';

export enum StorageStatus {
  /** `save=true`: a copy waits for the background write (task 2.4). */
  PENDING = 'pending',
  STORED = 'stored',
  /** The copy could not be retained; the result was still returned. */
  FAILED = 'failed',
}

/**
 * The stored copy of a result, kept apart from `transformations` so that the
 * history table stays free of storage details. At most one object per
 * transformation; the key is opaque (no user id, no file name).
 */
@Entity('transformation_objects')
export class TransformationObject {
  @PrimaryColumn({ name: 'transformation_id', type: 'uuid' })
  transformationId!: string;

  @OneToOne(() => Transformation, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'transformation_id' })
  transformation!: Transformation;

  @Index('UQ_transformation_objects_key', { unique: true })
  @Column({ name: 'storage_key', type: 'varchar', length: 64 })
  storageKey!: string;

  @Column({
    name: 'storage_status',
    type: 'enum',
    enum: StorageStatus,
    default: StorageStatus.PENDING,
  })
  storageStatus!: StorageStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
