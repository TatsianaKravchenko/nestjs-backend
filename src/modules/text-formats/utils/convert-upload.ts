import type { MultipartFile } from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';

import {
  invalidRequest,
  unsupportedMediaType,
} from '@/modules/auth/errors/auth.errors';

import { CONVERT_FIELDS } from '../dto/convert-fields.dto';
import type { TextFormat } from '../services/text-converter';

const SOURCE_BY_EXTENSION: Readonly<Record<string, TextFormat>> = {
  csv: 'csv',
  json: 'json',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
};

const GENERIC = ['text/plain', 'application/octet-stream'];
const ALLOWED_MIME: Record<TextFormat, readonly string[]> = {
  csv: ['text/csv', 'application/csv', 'application/vnd.ms-excel', ...GENERIC],
  json: ['application/json', 'text/json', ...GENERIC],
  xml: ['application/xml', 'text/xml', ...GENERIC],
  yaml: [
    'application/yaml',
    'application/x-yaml',
    'text/yaml',
    'text/x-yaml',
    ...GENERIC,
  ],
};

/**
 * The extension declares the format, the client MIME type is a second check;
 * the converter then confirms the content by really parsing it. The file name
 * is only read for its extension, never stored or logged.
 */
export function detectSource(filename: string, mimetype: string): TextFormat {
  const dot = filename.lastIndexOf('.');
  const source =
    dot < 0
      ? undefined
      : SOURCE_BY_EXTENSION[filename.slice(dot + 1).toLowerCase()];
  if (!source || !ALLOWED_MIME[source].includes(mimetype.toLowerCase())) {
    throw unsupportedMediaType('This conversion is not supported');
  }
  return source;
}

export interface UploadedFile {
  filename: string;
  mimetype: string;
  /** The whole file, at most one byte over the input limit. */
  data: Buffer;
  /** The client sent more than the input limit. */
  truncated: boolean;
}

export interface Upload {
  /** Text fields, in whatever order they arrived. */
  fields: Record<string, string>;
  file: UploadedFile;
  /**
   * The body held something it must not: an unknown or repeated field, a
   * second file, or more parts than the limits allow. The request is a 400.
   */
  violation: boolean;
}

// Above what a valid request needs (two fields and one file), so that an
// extra part is seen and reported as a violation instead of being cut off.
const FIELD_LIMIT = 6;
const FILE_LIMIT = 2;
const PART_LIMIT = 8;
const LIMIT_CODES = new Set([
  'FST_PARTS_LIMIT',
  'FST_FILES_LIMIT',
  'FST_FIELDS_LIMIT',
]);

/** Buffers one file part; a file over the limit is reported, not thrown. */
async function bufferFile(part: MultipartFile): Promise<UploadedFile> {
  const chunks: Buffer[] = [];
  let truncated = false;
  try {
    for await (const chunk of part.file) chunks.push(chunk as Buffer);
  } catch (error) {
    if ((error as { code?: string }).code !== 'FST_REQ_FILE_TOO_LARGE') {
      throw error;
    }
    truncated = true;
  }
  return {
    filename: part.filename,
    mimetype: part.mimetype,
    data: Buffer.concat(chunks),
    truncated: truncated || part.file.truncated === true,
  };
}

/**
 * Reads the whole multipart body, so `targetFormat`, `save` and `file` work in
 * any order. The file is held in memory (at most the input limit, 10 MiB by
 * default) and handed to the pipeline afterwards. The per-request limits
 * replace the global ones (no text fields, 5 MiB), which belong to the photo
 * upload.
 */
export async function readUpload(
  request: FastifyRequest,
  maxInputBytes: number,
): Promise<Upload> {
  if (!request.isMultipart()) {
    throw unsupportedMediaType('Content-Type must be multipart/form-data');
  }
  const parts = request.parts({
    limits: {
      // One byte more than the limit, so that the service sees "too large".
      fileSize: maxInputBytes + 1,
      files: FILE_LIMIT,
      fields: FIELD_LIMIT,
      fieldSize: 256,
      parts: PART_LIMIT,
    },
  });
  const fields: Record<string, string> = {};
  let file: UploadedFile | undefined;
  let violation = false;
  try {
    for (;;) {
      const next = await parts.next();
      if (next.done) break;
      const part = next.value;
      if (part.type === 'field') {
        if (
          !(CONVERT_FIELDS as readonly string[]).includes(part.fieldname) ||
          Object.hasOwn(fields, part.fieldname) ||
          typeof part.value !== 'string' ||
          part.valueTruncated
        ) {
          violation = true;
        } else {
          fields[part.fieldname] = part.value;
        }
        continue;
      }
      if (part.fieldname !== 'file' || file) {
        part.file.resume();
        violation = true;
        continue;
      }
      file = await bufferFile(part);
      // Nothing else matters for an oversized file: stop reading it.
      if (file.truncated) break;
    }
  } catch (error) {
    if (!LIMIT_CODES.has((error as { code?: string }).code ?? '')) {
      throw invalidRequest('Malformed multipart body');
    }
    violation = true;
  }
  if (!file) throw invalidRequest('The file field is missing');
  return { fields, file, violation };
}
