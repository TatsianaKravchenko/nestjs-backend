import { EntityManager } from 'typeorm';

import { RBAC_MANAGE_ACTION, RBAC_PERMISSION } from './rbac.constants';

/**
 * Is there an `active` user holding `rbac@manage` (through any role)? Blocked,
 * deleting and deleted users do not count. `exclude` ignores one user (the one
 * about to be blocked); `only` asks about one user.
 *
 * Callers hold the policy-version lock, so the answer cannot change under them.
 */
export async function hasActiveManageHolder(
  manager: EntityManager,
  filter: { exclude?: string; only?: string } = {},
): Promise<boolean> {
  const rows: unknown[] = await manager.query(
    `SELECT 1 FROM user_roles ur
       JOIN users u ON u.id = ur.user_id AND u.status = 'active'
       JOIN role_grants g ON g.role_id = ur.role_id
       JOIN permissions p ON p.id = g.permission_id
      WHERE p.name = $1 AND $2 = ANY (p.actions)
        AND (g.all_actions OR $2 = ANY (g.actions))
        AND ($3::uuid IS NULL OR ur.user_id <> $3::uuid)
        AND ($4::uuid IS NULL OR ur.user_id = $4::uuid)
      LIMIT 1`,
    [
      RBAC_PERMISSION,
      RBAC_MANAGE_ACTION,
      filter.exclude ?? null,
      filter.only ?? null,
    ],
  );
  return rows.length > 0;
}
