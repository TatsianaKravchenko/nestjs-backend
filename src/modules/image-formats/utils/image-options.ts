import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { invalidRequest } from '@/modules/auth/errors/auth.errors';

import { ImageOptionsDto } from '../dto/image-convert-fields.dto';

export const DEFAULT_QUALITY = 85;
export const DEFAULT_BACKGROUND = '#ffffff';

/** Options after validation, with defaults. Only what applies to the direction is set. */
export type ImageOptions = {
  quality?: number;
  /** `#rrggbb`, lowercase. */
  background?: string;
  width?: number;
  height?: number;
};

const KEYS = new Set(['quality', 'background', 'width', 'height']);
const JPEG_ONLY = ['quality', 'background'] as const;
const SVG_ONLY = ['width', 'height'] as const;

const bad = () => invalidRequest('The file or the parameters are invalid');

/**
 * Parses and validates the `options` field for one direction. Unknown options,
 * options that do not apply (quality/background for a png target, width/height
 * for a raster source), wrong types and out-of-range values are all a 400.
 */
export function parseImageOptions(
  raw: string | undefined,
  source: string,
  target: string,
): ImageOptions {
  let given: Record<string, unknown> = {};
  if (raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw bad();
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw bad();
    }
    given = parsed as Record<string, unknown>;
  }

  const keys = Object.keys(given);
  if (keys.some((key) => !KEYS.has(key))) throw bad();
  // `null` is not "absent": it is a wrong value.
  if (Object.values(given).some((value) => value === null)) throw bad();
  if (target !== 'jpeg' && JPEG_ONLY.some((key) => key in given)) throw bad();
  if (source !== 'svg' && SVG_ONLY.some((key) => key in given)) throw bad();

  const dto = plainToInstance(ImageOptionsDto, given);
  if (validateSync(dto, { forbidUnknownValues: true }).length > 0) throw bad();

  const options: ImageOptions = {};
  if (target === 'jpeg') {
    options.quality = dto.quality ?? DEFAULT_QUALITY;
    options.background = (dto.background ?? DEFAULT_BACKGROUND).toLowerCase();
  }
  if (source === 'svg') {
    if (dto.width !== undefined) options.width = dto.width;
    if (dto.height !== undefined) options.height = dto.height;
  }
  return options;
}
