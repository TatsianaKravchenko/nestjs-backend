import type { FastifyRequest } from 'fastify';

import { unsupportedMediaType } from '@/modules/auth/errors/auth.errors';
import {
  readUpload as readMultipart,
  type Upload,
} from '@/modules/transformations/utils/multipart-upload';

import {
  IMAGE_CONVERT_FIELDS,
  OPTIONS_FIELD_MAX_LENGTH,
} from '../dto/image-convert-fields.dto';
import type { ImageSource } from '../services/image-converter';

const SOURCE_BY_EXTENSION: Readonly<Record<string, ImageSource>> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  svg: 'svg',
};

const GENERIC = ['application/octet-stream'];
const ALLOWED_MIME: Record<ImageSource, readonly string[]> = {
  png: ['image/png', ...GENERIC],
  jpeg: ['image/jpeg', 'image/pjpeg', ...GENERIC],
  svg: [
    'image/svg+xml',
    'image/svg',
    'text/xml',
    'application/xml',
    ...GENERIC,
  ],
};

/**
 * The extension declares the format and the client MIME type must agree; the
 * converter then checks the bytes. The file name is only read for its
 * extension, never stored or logged.
 */
export function detectImageSource(
  filename: string,
  mimetype: string,
): ImageSource {
  const dot = filename.lastIndexOf('.');
  const source =
    dot < 0
      ? undefined
      : SOURCE_BY_EXTENSION[filename.slice(dot + 1).toLowerCase()];
  if (
    !source ||
    !ALLOWED_MIME[source].includes(mimetype.split(';')[0].trim().toLowerCase())
  ) {
    throw unsupportedMediaType('This conversion is not supported');
  }
  return source;
}

/** Reads the multipart body of `POST /images/convert`. */
export const readImageUpload = (
  request: FastifyRequest,
  maxInputBytes: number,
): Promise<Upload> =>
  readMultipart(
    request,
    maxInputBytes,
    IMAGE_CONVERT_FIELDS,
    OPTIONS_FIELD_MAX_LENGTH,
  );
