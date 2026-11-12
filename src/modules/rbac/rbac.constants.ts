export const RBAC_PERMISSION = 'rbac';
export const RBAC_MANAGE_ACTION = 'manage';

export const USERS_PERMISSION = 'users';
export const USERS_READ_ACTION = 'read';
/** Read the profile and photo of another user. */
export const USERS_READ_ANY_ACTION = 'read_any';
export const USERS_ACTIONS = [
  USERS_READ_ACTION,
  USERS_READ_ANY_ACTION,
  'update',
  'delete',
  'list',
];

export const DEFAULT_ROLE = 'user';
export const ADMIN_ROLE = 'admin';

/** Names of roles, permissions and actions: lowercase, 1-64 chars. */
export const NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_ACTIONS = 64;

/** The single row of `rbac_policy_state` holds the policy version. */
export const POLICY_STATE_ID = 1;

export const REQUIRED_PERMISSION_KEY = 'rbac:required-permission';
export const AUDIT_KEY = 'rbac:audit';
