/** Outcome of one eraser run. Codes are short and safe: never a message or a key. */
export type EraseResult =
  | { status: 'succeeded' }
  | { status: 'retryable_failure'; code: string }
  | { status: 'permanent_failure'; code: string };

/**
 * Removes the data one module keeps about a user. Must be idempotent: the
 * worker repeats it after a failure or an expired lease, and a missing object
 * or row counts as `succeeded`.
 */
export interface UserEraser {
  /** The data store this eraser covers; one of `USER_DATA_STORES`. */
  readonly store: string;
  erase(userId: string): Promise<EraseResult>;
}

/**
 * Every module that stores user data. Readiness fails while one of these has no
 * registered eraser: add the name here when a module starts storing user data.
 */
export const USER_DATA_STORES = [
  'users.photo',
  'auth.challenges',
  'rbac.roles',
] as const;
