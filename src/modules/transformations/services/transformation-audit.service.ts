import { Injectable, Logger } from '@nestjs/common';

export interface TransformationAuditFields {
  requestId: string;
  transformationId?: string;
  userId: string;
  type: string;
  sourceFormat: string;
  targetFormat: string;
  inputSize?: number;
  outputSize?: number | null;
  durationMs?: number;
  result: 'success' | 'error' | 'rejected';
  errorCode?: string;
  status?: number;
}

/** One stored-file operation (save, download, delete). No key, path or bucket field exists. */
export interface StorageAuditFields {
  requestId?: string;
  /** The owner of the file. */
  userId?: string;
  /** The administrator, on the admin download route. */
  actorUserId?: string;
  transformationId?: string;
  action: 'save' | 'download' | 'delete';
  /** Bytes of the file, when known. */
  size?: number;
  outcome: 'success' | 'error' | 'not_found' | 'not_ready' | 'unavailable';
  errorCode?: string;
  durationMs: number;
}

type Level = 'log' | 'warn' | 'error';
type Value = string | number | null;

const STORAGE_FIELD_NAMES: (keyof StorageAuditFields)[] = [
  'requestId',
  'userId',
  'actorUserId',
  'transformationId',
  'action',
  'size',
  'outcome',
  'errorCode',
  'durationMs',
];

const SAFE_TOKEN = /^[A-Za-z0-9._+:-]{1,64}$/;
const FIELD_NAMES: (keyof TransformationAuditFields)[] = [
  'requestId',
  'transformationId',
  'userId',
  'type',
  'sourceFormat',
  'targetFormat',
  'inputSize',
  'outputSize',
  'durationMs',
  'result',
  'errorCode',
  'status',
];

/**
 * Structured log of the transformation pipeline. Only the fields above can be
 * logged (an allow-list, so a new field is a conscious change), and a string
 * that is not a plain token becomes `?`. File contents, original names, temp
 * paths, JWTs, cookies, multipart bodies and stack traces have no field.
 */
@Injectable()
export class TransformationAuditService {
  private readonly logger = new Logger('TransformationAudit');

  info(event: string, fields: TransformationAuditFields): void {
    this.write('log', event, fields);
  }

  warn(event: string, fields: TransformationAuditFields): void {
    this.write('warn', event, fields);
  }

  error(event: string, fields: TransformationAuditFields): void {
    this.write('error', event, fields);
  }

  /** Audit of a stored-file operation: who, which transformation, action, size, outcome, duration. */
  storage(level: Level, event: string, fields: StorageAuditFields): void {
    this.write(level, event, fields, STORAGE_FIELD_NAMES);
  }

  private write(
    level: Level,
    event: string,
    fields: TransformationAuditFields | StorageAuditFields,
    names: readonly string[] = FIELD_NAMES,
  ): void {
    const entry: Record<string, Value> = { event };
    for (const name of names) {
      const value = (fields as unknown as Record<string, Value | undefined>)[
        name
      ];
      if (value === undefined) continue;
      if (typeof value === 'number') {
        if (Number.isFinite(value)) entry[name] = value;
      } else if (value === null) {
        entry[name] = null;
      } else {
        entry[name] = SAFE_TOKEN.test(value) ? value : '?';
      }
    }
    this.logger[level](entry);
  }
}
