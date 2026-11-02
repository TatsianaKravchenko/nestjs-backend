import { EntityManager } from 'typeorm';

import { PolicyState } from './entities/policy-state.entity';
import { POLICY_STATE_ID } from './rbac.constants';

/** Serializes policy changes: the row lock is held until the transaction ends. */
export async function lockPolicyVersion(
  manager: EntityManager,
): Promise<number> {
  const state = await manager.findOne(PolicyState, {
    where: { id: POLICY_STATE_ID },
    lock: { mode: 'pessimistic_write' },
  });
  if (!state) {
    throw new Error('rbac_policy_state row is missing');
  }
  return state.version;
}

/** Bumps the version inside the caller's transaction so data and version commit together. */
export async function bumpPolicyVersion(
  manager: EntityManager,
): Promise<number> {
  const result = await manager
    .createQueryBuilder()
    .update(PolicyState)
    .set({ version: () => 'version + 1' })
    .where('id = :id', { id: POLICY_STATE_ID })
    .returning('version')
    .execute();
  const rows = result.raw as { version: number }[];
  if (!rows[0]) {
    throw new Error('rbac_policy_state row is missing');
  }
  return rows[0].version;
}
