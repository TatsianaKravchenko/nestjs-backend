import type { FastifyRequest } from 'fastify';

import { unsupportedMediaType } from '@/modules/auth/errors/auth.errors';
import {
  readUpload as readMultipart,
  type Upload,
} from '@/modules/transformations/utils/multipart-upload';

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

export type {
  Upload,
  UploadedFile,
} from '@/modules/transformations/utils/multipart-upload';

/** Reads the multipart body of `POST /convert` (`targetFormat`, `save`, `file`). */
export const readUpload = (
  request: FastifyRequest,
  maxInputBytes: number,
): Promise<Upload> => readMultipart(request, maxInputBytes, CONVERT_FIELDS);
