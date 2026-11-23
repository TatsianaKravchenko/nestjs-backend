import { Resvg, renderAsync } from '@resvg/resvg-js';
import sharp from 'sharp';
import type { Readable } from 'stream';

import { TransformationType } from '@/modules/transformations/entities/transformation.entity';
import {
  ConverterFailure,
  type ConversionOutcome,
  type ConversionRequest,
  type Converter,
  type ConverterLimits,
} from '@/modules/transformations/services/converter';

import { MAX_SIDE } from '../dto/image-convert-fields.dto';
import {
  DEFAULT_BACKGROUND,
  DEFAULT_QUALITY,
  type ImageOptions,
} from '../utils/image-options';
import { sanitizeSvg } from '../utils/svg-sanitizer';

export const IMAGE_SOURCES = ['png', 'jpeg', 'svg'] as const;
export type ImageSource = (typeof IMAGE_SOURCES)[number];
export const IMAGE_TARGETS = ['png', 'jpeg'] as const;
export type ImageTarget = (typeof IMAGE_TARGETS)[number];

export const IMAGE_MEDIA: Record<
  ImageTarget,
  { contentType: string; extension: string }
> = {
  png: { contentType: 'image/png', extension: 'png' },
  jpeg: { contentType: 'image/jpeg', extension: 'jpeg' },
};

export const MAX_PIXELS = 16_777_216;
/** Size of an SVG that declares neither a size nor a viewBox, and no option asks for one. */
export const FALLBACK_SVG_SIDE = 1024;

async function readInput(input: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const write = (request: ConversionRequest, data: Buffer): Promise<void> =>
  new Promise((resolve, reject) => {
    request.output.write(data, (error) => (error ? reject(error) : resolve()));
  });

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ConverterFailure('timeout');
}

/** Dimensions and pixel count are checked from the header, before any decoding. */
function checkDimensions(width: number, height: number): void {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new ConverterFailure('invalid_input');
  }
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new ConverterFailure('image_too_large');
  }
}

/** `#rrggbb` (validated before) as a colour for sharp. */
function colour(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

/**
 * The last step of every direction: the image is encoded again from pixels, so
 * nothing of the input (EXIF, GPS, ICC, text chunks, file name) survives.
 * A jpeg has no alpha: transparency is flattened onto the background first.
 */
function encode(
  image: sharp.Sharp,
  target: ImageTarget,
  options: ImageOptions,
) {
  if (target === 'jpeg') {
    return image
      .flatten({ background: colour(options.background ?? DEFAULT_BACKGROUND) })
      .jpeg({ quality: options.quality ?? DEFAULT_QUALITY })
      .toBuffer();
  }
  return image.png().toBuffer();
}

/** Where the output box of an SVG comes from; see `svgBox`. */
function svgBox(
  natural: { width: number; height: number },
  known: boolean,
  options: ImageOptions,
): [number, number] {
  const { width, height } = options;
  const usable =
    Number.isFinite(natural.width) &&
    Number.isFinite(natural.height) &&
    natural.width > 0 &&
    natural.height > 0;
  if (width !== undefined && height !== undefined) return [width, height];
  if (!usable) {
    return [width ?? FALLBACK_SVG_SIDE, height ?? FALLBACK_SVG_SIDE];
  }
  if (width !== undefined) {
    return [
      width,
      Math.max(1, Math.round((width * natural.height) / natural.width)),
    ];
  }
  if (height !== undefined) {
    return [
      Math.max(1, Math.round((height * natural.width) / natural.height)),
      height,
    ];
  }
  return known
    ? [Math.ceil(natural.width), Math.ceil(natural.height)]
    : [FALLBACK_SVG_SIDE, FALLBACK_SVG_SIDE];
}

/**
 * One direction between raster images and SVG, done by maintained libraries
 * (sharp for PNG/JPEG, resvg for SVG): no codec of our own. The converter
 * checks sizes before decoding, applies EXIF orientation, and re-encodes.
 */
export class ImageConverter implements Converter {
  readonly type = TransformationType.IMAGE;

  constructor(
    readonly source: ImageSource,
    readonly target: ImageTarget,
    readonly limits: ConverterLimits,
  ) {}

  async convert(request: ConversionRequest): Promise<ConversionOutcome> {
    const data = await readInput(request.input);
    checkAborted(request.signal);
    const options = request.params as ImageOptions;
    const result =
      this.source === 'svg'
        ? await this.fromSvg(data, options, request.signal)
        : await this.fromRaster(data, options);
    checkAborted(request.signal);
    await write(request, result);
    return { ok: true, size: result.length, ...IMAGE_MEDIA[this.target] };
  }

  private async fromRaster(data: Buffer, options: ImageOptions) {
    const input = {
      limitInputPixels: MAX_PIXELS,
      failOn: 'error',
    } as const;
    let header: sharp.Metadata;
    try {
      // Header only; our own limits are checked right after, so the size
      // limit of the decoder must not turn into a generic "invalid" here.
      header = await sharp(data, { limitInputPixels: false }).metadata();
    } catch {
      throw new ConverterFailure('invalid_input');
    }
    // The content, not the name, decides: a jpeg called .png is not a png.
    if (header.format !== this.source)
      throw new ConverterFailure('invalid_input');
    checkDimensions(header.width ?? 0, header.height ?? 0);
    try {
      // `rotate()` applies the EXIF orientation and drops the tag.
      return await encode(sharp(data, input).rotate(), this.target, options);
    } catch {
      throw new ConverterFailure('invalid_input');
    }
  }

  private async fromSvg(
    data: Buffer,
    options: ImageOptions,
    signal: AbortSignal,
  ) {
    const { text, hasIntrinsicSize } = sanitizeSvg(data);
    const renderOptions = { logLevel: 'off' } as const;
    let natural: { width: number; height: number };
    try {
      const parsed = new Resvg(text, renderOptions);
      natural = { width: parsed.width, height: parsed.height };
    } catch {
      throw new ConverterFailure('invalid_input');
    }
    const [boxWidth, boxHeight] = svgBox(natural, hasIntrinsicSize, options);
    checkDimensions(boxWidth, boxHeight);
    checkAborted(signal);

    const usable = natural.width > 0 && natural.height > 0;
    const byWidth =
      !usable || boxWidth / natural.width <= boxHeight / natural.height;
    let png: Buffer;
    try {
      const rendered = await renderAsync(
        text,
        {
          ...renderOptions,
          fitTo: byWidth
            ? { mode: 'width', value: boxWidth }
            : { mode: 'height', value: boxHeight },
        },
        signal,
      );
      png = rendered.asPng();
    } catch {
      checkAborted(signal);
      throw new ConverterFailure('conversion_failed');
    }

    try {
      let image = sharp(png, { limitInputPixels: MAX_PIXELS });
      const rendered = await image.metadata();
      if (rendered.width !== boxWidth || rendered.height !== boxHeight) {
        // Both sizes given: exactly that size (stretched, no padding).
        image = image.resize({
          width: boxWidth,
          height: boxHeight,
          fit: 'fill',
        });
      }
      return await encode(image, this.target, options);
    } catch {
      throw new ConverterFailure('conversion_failed');
    }
  }
}
