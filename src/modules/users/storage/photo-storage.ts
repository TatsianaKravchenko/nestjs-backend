import type { Readable } from 'stream';

/** Result of reading one object. `unavailable` means the store itself failed. */
export type PhotoReadResult =
  | { status: 'found'; stream: Readable }
  | { status: 'not_found' }
  | { status: 'unavailable' };

export type PhotoDeleteResult = 'deleted' | 'not_found' | 'unavailable';

export interface StoredObject {
  key: string;
  lastModified: Date;
}

/**
 * Storage abstraction for profile photos (opaque keys only). The production
 * implementation is an S3-compatible store (task 2.4); the local filesystem
 * one is for single-instance development only. `read` and `delete` never
 * throw; `write` and `listOlderThan` throw when the store fails.
 */
export interface PhotoStorage {
  read(key: string): Promise<PhotoReadResult>;
  write(key: string, data: Buffer): Promise<void>;
  /** A missing object is `not_found`, which callers treat as success. */
  delete(key: string): Promise<PhotoDeleteResult>;
  /** Objects last modified before `cutoff`, for the orphan sweep. */
  listOlderThan(cutoff: Date): Promise<StoredObject[]>;
}

export const PHOTO_STORAGE = Symbol('PHOTO_STORAGE');
