export type ResultDeleteResult = 'deleted' | 'not_found' | 'unavailable';

/**
 * Where a `save=true` result is kept. The production implementation is an
 * S3-compatible store with a background writer (task 2.4); the local one is
 * for single-instance development. Keys are opaque. `delete` never throws:
 * a missing object is `not_found`, which callers treat as success.
 */
export interface ResultStore {
  /**
   * Keeps a copy of a finished temporary file for the background write. It
   * must be cheap: the HTTP response waits for it. Throws when it fails.
   */
  retain(key: string, sourcePath: string): Promise<void>;
  delete(key: string): Promise<ResultDeleteResult>;
}

export const RESULT_STORE = Symbol('RESULT_STORE');
