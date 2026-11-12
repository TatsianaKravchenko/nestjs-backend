import type { Readable } from 'stream';

/** Result of reading one object. `unavailable` means the store itself failed. */
export type PhotoReadResult =
  | { status: 'found'; stream: Readable }
  | { status: 'not_found' }
  | { status: 'unavailable' };

/**
 * Storage abstraction for profile photos. The production implementation is an
 * S3-compatible store (task 2.4); the local filesystem one is for
 * single-instance development only. `read` never throws: it reports one of
 * three outcomes, and the object is streamed, never buffered.
 */
export interface PhotoStorage {
  read(key: string): Promise<PhotoReadResult>;
}

export const PHOTO_STORAGE = Symbol('PHOTO_STORAGE');
