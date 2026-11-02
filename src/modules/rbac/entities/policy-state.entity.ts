import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Single-row table; `version` grows with every committed policy change. */
@Entity('rbac_policy_state')
export class PolicyState {
  @PrimaryColumn({ type: 'smallint' })
  id!: number;

  @Column({ type: 'int', default: 1 })
  version!: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
