import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Injectable, Logger } from '@nestjs/common';
import { createReadStream } from 'fs';
import { Readable } from 'stream';

import { ConfigService } from '@/core/config/config.service';

import {
  ObjectNotFoundError,
  type ObjectDeleteResult,
  type ObjectStorage,
  StoragePermanentError,
  StorageUnavailableError,
  STORAGE_KEY_PATTERN,
  type StoredObject,
} from './object-storage';

/** HTTP statuses that a retry cannot fix. Throttling (429, 503) and 5xx retry. */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 405, 413]);

const httpStatus = (error: unknown): number | undefined =>
  (error as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;

const errorName = (error: unknown): string =>
  (error as { name?: string }).name ?? 'unknown';

/**
 * `ObjectStorage` for any S3-compatible service. Objects are written without an
 * ACL, so they inherit the bucket's private default; there is no presigned or
 * public URL: downloads stream through the API. Re-saving a key overwrites it
 * (idempotent). Failures are logged by error name only, never with the bucket,
 * the key, the endpoint or the credentials.
 */
@Injectable()
export class S3ObjectStorage implements ObjectStorage {
  private readonly logger = new Logger(S3ObjectStorage.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    this.bucket = config.get('TRANSFORM_S3_BUCKET');
    const accessKeyId = config.get('TRANSFORM_S3_ACCESS_KEY_ID');
    const secretAccessKey = config.get('TRANSFORM_S3_SECRET_ACCESS_KEY');
    this.client = new S3Client({
      region: config.get('TRANSFORM_S3_REGION') || 'us-east-1',
      endpoint: config.get('TRANSFORM_S3_ENDPOINT') || undefined,
      forcePathStyle:
        String(config.get('TRANSFORM_S3_FORCE_PATH_STYLE')) === 'true',
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
    });
  }

  async save(key: string, sourcePath: string): Promise<void> {
    if (!STORAGE_KEY_PATTERN.test(key)) throw new StoragePermanentError('key');
    const body = createReadStream(sourcePath);
    try {
      await new Upload({
        client: this.client,
        params: { Bucket: this.bucket, Key: key, Body: body },
      }).done();
    } catch (error) {
      body.destroy();
      this.fail('save', error);
      const status = httpStatus(error);
      if (status !== undefined && PERMANENT_STATUSES.has(status)) {
        throw new StoragePermanentError('storage_rejected');
      }
      throw new StorageUnavailableError();
    }
  }

  async read(key: string): Promise<StoredObject> {
    if (!STORAGE_KEY_PATTERN.test(key)) throw new ObjectNotFoundError();
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!(out.Body instanceof Readable)) throw new StorageUnavailableError();
      return { stream: out.Body, size: out.ContentLength ?? 0 };
    } catch (error) {
      if (error instanceof StorageUnavailableError) throw error;
      if (errorName(error) === 'NoSuchKey' || httpStatus(error) === 404) {
        throw new ObjectNotFoundError();
      }
      this.fail('read', error);
      throw new StorageUnavailableError();
    }
  }

  async delete(key: string): Promise<ObjectDeleteResult> {
    if (!STORAGE_KEY_PATTERN.test(key)) return 'not_found';
    try {
      // S3 answers 204 for a missing key too; there is no way to tell.
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return 'deleted';
    } catch (error) {
      if (errorName(error) === 'NoSuchKey' || httpStatus(error) === 404) {
        return 'not_found';
      }
      this.fail('delete', error);
      return 'unavailable';
    }
  }

  private fail(operation: string, error: unknown): void {
    this.logger.error({
      event: 'transformation.storage_failed',
      category: 'storage',
      operation,
      errorCode: errorName(error),
    });
  }
}
