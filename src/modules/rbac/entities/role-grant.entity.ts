import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { Permission } from './permission.entity';
import { Role } from './role.entity';

/** Gives a role some (or all) actions of a permission. One grant per role-permission pair. */
@Entity('role_grants')
@Unique(['roleId', 'permissionId'])
export class RoleGrant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Role, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'role_id' })
  role!: Role;

  @Column({ name: 'role_id', type: 'uuid' })
  roleId!: string;

  @ManyToOne(() => Permission, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'permission_id' })
  permission!: Permission;

  @Index()
  @Column({ name: 'permission_id', type: 'uuid' })
  permissionId!: string;

  /** True covers every current and future action of the permission. */
  @Column({ name: 'all_actions', type: 'boolean', default: false })
  allActions!: boolean;

  /** Explicit actions; always empty when `allActions` is true. */
  @Column({
    type: 'varchar',
    length: 64,
    array: true,
    default: () => "'{}'",
  })
  actions!: string[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
