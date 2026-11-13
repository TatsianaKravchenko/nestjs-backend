import { Injectable } from '@nestjs/common';
import sharp from 'sharp';

import {
  invalidImage,
  unsupportedMediaType,
} from '@/modules/auth/errors/auth.errors';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MIN_SIDE = 64;
export const MAX_SIDE = 4096;
export const OUTPUT_BOX = 1024;

type Container = 'jpeg' | 'png' | 'webp';

const MIME_BY_CONTAINER: Record<Container, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};
const QUALITIES = [85, 70, 55, 40];

/** Container by signature (magic bytes); null for anything unsupported. */
export function sniffContainer(data: Buffer): Container | null {
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return 'jpeg';
  }
  if (
    data.length >= 8 &&
    data
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/** APNG carries an `acTL` chunk before the first `IDAT`. */
function isAnimatedPng(data: Buffer): boolean {
  let offset = 8;
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString('latin1');
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
    offset += 12 + length;
  }
  return false;
}

/**
 * Turns an upload into the one stored form: a single-frame WebP, EXIF
 * orientation applied, fitted into 1024x1024 without enlarging, all metadata
 * removed (sharp drops it unless asked to keep it), at most 2 MiB.
 */
@Injectable()
export class ImageNormalizer {
  async normalize(data: Buffer, declaredMime: string): Promise<Buffer> {
    const container = sniffContainer(data);
    if (!container) throw unsupportedMediaType('Unsupported image format');
    if (MIME_BY_CONTAINER[container] !== declaredMime.toLowerCase()) {
      throw unsupportedMediaType('Declared type does not match the content');
    }
    if (container === 'png' && isAnimatedPng(data)) {
      throw invalidImage('Animated images are not accepted');
    }

    const options = {
      animated: true,
      failOn: 'warning' as const,
      limitInputPixels: MAX_SIDE * MAX_SIDE,
    };
    let width: number;
    let height: number;
    try {
      const meta = await sharp(data, options).metadata();
      if ((meta.pages ?? 1) > 1) {
        throw invalidImage('Animated images are not accepted');
      }
      width = meta.width ?? 0;
      height = meta.height ?? 0;
    } catch (error) {
      if (error instanceof Error && 'getStatus' in error) throw error;
      throw invalidImage('The image is corrupt or too large');
    }
    if (width < MIN_SIDE || height < MIN_SIDE) {
      throw invalidImage(`The image must be at least ${MIN_SIDE}x${MIN_SIDE}`);
    }
    if (width > MAX_SIDE || height > MAX_SIDE) {
      throw invalidImage(`The image must be at most ${MAX_SIDE}x${MAX_SIDE}`);
    }

    for (const quality of QUALITIES) {
      let output: Buffer;
      try {
        output = await sharp(data, { ...options, animated: false })
          .rotate()
          .resize({
            width: OUTPUT_BOX,
            height: OUTPUT_BOX,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality })
          .toBuffer();
      } catch {
        throw invalidImage('The image is corrupt');
      }
      if (output.length <= MAX_OUTPUT_BYTES) return output;
    }
    throw invalidImage('The image cannot be reduced below 2 MiB');
  }
}
