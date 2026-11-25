import type { Readable } from 'stream';

export type ObjectDeleteResult = 'deleted' | 'not_found' | 'unavailable';

/** Opaque server-generated keys only: 16-64 URL-safe characters. */
export const STORAGE_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** The object does not exist. */
export class ObjectNotFoundError extends Error {
  constructor() {
    super('object_not_found');
  }
}

/** The store failed in a way a retry may fix (network, throttling, disk). */
export class StorageUnavailableError extends Error {
  constructor() {
    super('storage_unavailable');
  }
}

/** The store refused the write for good (bad credentials, missing bucket, bad key). */
export class StoragePermanentError extends Error {
  constructor(readonly code: string = 'storage_rejected') {
    super(code);
  }
}

export interface StoredObject {
  stream: Readable;
  size: number;
}

/**
 * Permanent store of saved results (`TRANSFORM_STORAGE_DRIVER`: local disk for
 * development, an S3-compatible service otherwise). Objects are private: there
 * is no public URL, only `read` through the API. Keys are opaque. Errors carry
 * a code only, never a path, bucket or library message.
 */
export interface ObjectStorage {
  /**
   * Writes the file under `key`. Idempotent: saving the same key again
   * replaces the object, so a retry after a failure is safe. Throws
   * `StorageUnavailableError` (retry) or `StoragePermanentError` (give up).
   */
  save(key: string, sourcePath: string): Promise<void>;
  /** Throws `ObjectNotFoundError` or `StorageUnavailableError`. */
  read(key: string): Promise<StoredObject>;
  /** Never throws: a missing object is `not_found`, which callers treat as success. */
  delete(key: string): Promise<ObjectDeleteResult>;
}

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');
