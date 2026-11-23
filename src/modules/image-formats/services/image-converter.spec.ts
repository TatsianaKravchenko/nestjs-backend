import { deflateSync } from 'zlib';
import sharp from 'sharp';
import { PassThrough, Readable } from 'stream';

import {
  ConverterFailure,
  type ConversionOutcome,
} from '@/modules/transformations/services/converter';

import type { ImageOptions } from '../utils/image-options';
import {
  FALLBACK_SVG_SIDE,
  ImageConverter,
  type ImageSource,
  type ImageTarget,
} from './image-converter';

const LIMITS = { maxInputBytes: 10_000_000, maxOutputBytes: 1e9, timeoutMs: 1 };

interface Run {
  outcome?: ConversionOutcome;
  failure?: string;
  data: Buffer;
}

async function run(
  source: ImageSource,
  target: ImageTarget,
  input: Buffer | string,
  params: ImageOptions = {},
  signal: AbortSignal = new AbortController().signal,
): Promise<Run> {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(chunk));
  const converter = new ImageConverter(source, target, LIMITS);
  try {
    const outcome = await converter.convert({
      input: Readable.from([Buffer.from(input)]),
      output,
      params,
      signal,
    });
    return { outcome, data: Buffer.concat(chunks) };
  } catch (error) {
    return {
      failure: error instanceof ConverterFailure ? error.code : 'unexpected',
      data: Buffer.concat(chunks),
    };
  }
}

const SVG = (
  attributes: string,
  body = '<rect width="40" height="20" fill="red"/>',
) => `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`;

/** A 2x1 image: left pixel red, right pixel blue. */
const twoPixels = (format: 'png' | 'jpeg') =>
  sharp(Buffer.from([255, 0, 0, 0, 0, 255]), {
    raw: { width: 2, height: 1, channels: 3 },
  })
    .toFormat(format, format === 'jpeg' ? { quality: 100 } : {})
    .toBuffer();

const pixel = async (data: Buffer, x: number, y: number) => {
  const { data: raw, info } = await sharp(data)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * 4;
  return [raw[at], raw[at + 1], raw[at + 2], raw[at + 3]];
};

const near = (actual: number[], expected: number[], tolerance = 12) =>
  actual.every((value, i) => Math.abs(value - expected[i]) <= tolerance);

describe('ImageConverter', () => {
  describe('raster directions', () => {
    it('png -> jpeg', async () => {
      const result = await run('png', 'jpeg', await twoPixels('png'));

      expect(result.outcome).toEqual({
        ok: true,
        contentType: 'image/jpeg',
        extension: 'jpeg',
        size: result.data.length,
      });
      const meta = await sharp(result.data).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 2, 1]);
    });

    it('jpeg -> png', async () => {
      const result = await run('jpeg', 'png', await twoPixels('jpeg'));

      expect(result.outcome).toMatchObject({
        contentType: 'image/png',
        extension: 'png',
      });
      const meta = await sharp(result.data).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['png', 2, 1]);
    });

    it('flattens transparency onto the white default background', async () => {
      const png = await sharp({
        create: {
          width: 2,
          height: 2,
          channels: 4,
          background: { r: 255, g: 0, b: 0, alpha: 0 },
        },
      })
        .png()
        .toBuffer();

      const result = await run('png', 'jpeg', png, {
        quality: 100,
        background: '#ffffff',
      });
      expect(near(await pixel(result.data, 0, 0), [255, 255, 255, 255])).toBe(
        true,
      );

      const green = await run('png', 'jpeg', png, {
        quality: 100,
        background: '#00ff00',
      });
      expect(near(await pixel(green.data, 1, 1), [0, 255, 0, 255])).toBe(true);
    });

    it('a lower quality gives a smaller file', async () => {
      const noise = await sharp({
        create: {
          width: 128,
          height: 128,
          channels: 3,
          background: '#000000',
          noise: { type: 'gaussian', mean: 128, sigma: 60 },
        },
      })
        .png()
        .toBuffer();

      const high = await run('png', 'jpeg', noise, { quality: 100 });
      const low = await run('png', 'jpeg', noise, { quality: 5 });
      expect(low.data.length).toBeLessThan(high.data.length);
    });

    it('applies the EXIF orientation and drops all metadata', async () => {
      // Stored 2x1 (red | blue) with orientation 6: shown rotated 90 degrees
      // clockwise, i.e. 1x2 with red on top.
      const source = await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), {
        raw: { width: 2, height: 1, channels: 3 },
      })
        .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
        .withMetadata({
          orientation: 6,
          exif: {
            IFD0: { Copyright: 'private-owner' },
            IFD3: { GPSLatitudeRef: 'N' },
          },
        })
        .toBuffer();
      expect((await sharp(source).metadata()).orientation).toBe(6);

      const result = await run('jpeg', 'png', source);

      const meta = await sharp(result.data).metadata();
      expect([meta.width, meta.height]).toEqual([1, 2]);
      expect(meta.orientation).toBeUndefined();
      expect(meta.exif).toBeUndefined();
      expect(result.data.includes(Buffer.from('private-owner'))).toBe(false);
      expect(near(await pixel(result.data, 0, 0), [255, 0, 0, 255])).toBe(true);
      expect(near(await pixel(result.data, 0, 1), [0, 0, 255, 255])).toBe(true);
    });

    it('strips PNG text chunks and ICC profiles', async () => {
      const source = await sharp({
        create: {
          width: 4,
          height: 4,
          channels: 3,
          background: { r: 1, g: 2, b: 3 },
        },
      })
        .withExif({ IFD0: { Copyright: 'private-owner' } })
        .png()
        .toBuffer();

      const result = await run('png', 'jpeg', source);
      expect(result.data.includes(Buffer.from('private-owner'))).toBe(false);
      expect((await sharp(result.data).metadata()).exif).toBeUndefined();
    });

    it('rejects a file whose content is not the declared format', async () => {
      expect((await run('png', 'jpeg', await twoPixels('jpeg'))).failure).toBe(
        'invalid_input',
      );
      expect((await run('jpeg', 'png', await twoPixels('png'))).failure).toBe(
        'invalid_input',
      );
    });

    it.each([['not an image'], [''], ['\x89PNG\r\n\x1a\ntruncated']])(
      'rejects corrupt input %j',
      async (garbage) => {
        expect((await run('png', 'jpeg', garbage)).failure).toBe(
          'invalid_input',
        );
      },
    );

    it('rejects a truncated image body', async () => {
      const png = await sharp({
        create: {
          width: 300,
          height: 300,
          channels: 3,
          background: '#000000',
          noise: { type: 'gaussian', mean: 128, sigma: 60 },
        },
      })
        .png()
        .toBuffer();
      const result = await run('png', 'jpeg', png.subarray(0, png.length / 2));
      expect(result.failure).toBe('invalid_input');
    });
  });

  describe('pixel limits (checked from the header, before decoding)', () => {
    /** A valid PNG header that claims a huge size; no pixel data follows. */
    const headerOnly = (width: number, height: number) => {
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(width, 0);
      ihdr.writeUInt32BE(height, 4);
      ihdr[8] = 8;
      ihdr[9] = 2;
      const crc32 = (buffer: Buffer) => {
        let crc = ~0;
        for (const byte of buffer) {
          crc ^= byte;
          for (let k = 0; k < 8; k++)
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
        return ~crc >>> 0;
      };
      const chunk = (type: string, data: Buffer) => {
        const body = Buffer.concat([Buffer.from(type), data]);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body));
        return Buffer.concat([length, body, crc]);
      };
      return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(Buffer.alloc(64))),
        chunk('IEND', Buffer.alloc(0)),
      ]);
    };

    it.each([
      ['a side over 4096', 4097, 1],
      ['a side over 4096 (tall)', 1, 5000],
      ['over 16,777,216 pixels', 4096, 4097 - 0],
      ['a decompression bomb', 60000, 60000],
    ])('rejects %s with image_too_large', async (_label, width, height) => {
      const result = await run('png', 'jpeg', headerOnly(width, height));
      expect(result.failure).toBe('image_too_large');
      expect(result.data.length).toBe(0);
    });

    it('accepts exactly 4096 x 4096', async () => {
      const image = await sharp({
        create: {
          width: 4096,
          height: 4096,
          channels: 3,
          background: { r: 9, g: 9, b: 9 },
        },
      })
        .png({ compressionLevel: 9 })
        .toBuffer();
      const result = await run('png', 'jpeg', image);
      expect(result.outcome).toMatchObject({ ok: true });
    }, 30_000);
  });

  describe('svg directions', () => {
    const size = async (data: Buffer) => {
      const { width, height, format } = await sharp(data).metadata();
      return [width, height, format];
    };

    it('svg -> png at the intrinsic size', async () => {
      const result = await run('svg', 'png', SVG('width="40" height="20"'));
      expect(result.outcome).toMatchObject({ contentType: 'image/png' });
      expect(await size(result.data)).toEqual([40, 20, 'png']);
      expect(near(await pixel(result.data, 5, 5), [255, 0, 0, 255])).toBe(true);
    });

    it('svg -> jpeg flattens the transparent background', async () => {
      const result = await run(
        'svg',
        'jpeg',
        SVG(
          'width="40" height="20"',
          '<rect width="20" height="20" fill="red"/>',
        ),
        { quality: 100, background: '#0000ff' },
      );
      expect(result.outcome).toMatchObject({ contentType: 'image/jpeg' });
      expect(await size(result.data)).toEqual([40, 20, 'jpeg']);
      expect(near(await pixel(result.data, 30, 10), [0, 0, 255, 255])).toBe(
        true,
      );
      expect(near(await pixel(result.data, 5, 10), [255, 0, 0, 255])).toBe(
        true,
      );
    });

    it('uses the viewBox when there is no width and height', async () => {
      const result = await run('svg', 'png', SVG('viewBox="0 0 30 10"'));
      expect(await size(result.data)).toEqual([30, 10, 'png']);
    });

    it('keeps the aspect ratio when only the width is given', async () => {
      const result = await run('svg', 'png', SVG('width="40" height="20"'), {
        width: 200,
      });
      expect(await size(result.data)).toEqual([200, 100, 'png']);
    });

    it('keeps the aspect ratio when only the height is given', async () => {
      const result = await run('svg', 'png', SVG('width="40" height="20"'), {
        height: 100,
      });
      expect(await size(result.data)).toEqual([200, 100, 'png']);
    });

    it('stretches to the exact size when both sides are given', async () => {
      const result = await run('svg', 'png', SVG('width="40" height="20"'), {
        width: 100,
        height: 100,
      });
      expect(await size(result.data)).toEqual([100, 100, 'png']);
      // The 2:1 drawing fills the whole box: no transparent padding.
      expect(near(await pixel(result.data, 50, 5), [255, 0, 0, 255])).toBe(
        true,
      );
      expect(near(await pixel(result.data, 50, 95), [255, 0, 0, 255])).toBe(
        true,
      );
    });

    it('falls back to 1024x1024 without any size information', async () => {
      const result = await run('svg', 'png', SVG(''));
      expect(await size(result.data)).toEqual([
        FALLBACK_SVG_SIDE,
        FALLBACK_SVG_SIDE,
        'png',
      ]);
    });

    it('an option scales an svg without size information by its content', async () => {
      const result = await run('svg', 'png', SVG(''), { width: 64 });
      expect(await size(result.data)).toEqual([64, 32, 'png']);
    });

    it.each([
      ['an intrinsic side over 4096', 'width="5000" height="10"', {}],
      [
        'a requested width over the limit',
        'width="10" height="10"',
        { width: 4097 },
      ],
      [
        'too many pixels',
        'width="10" height="10"',
        { width: 4096, height: 4096 + 1 },
      ],
    ])('rejects %s before rendering', async (_label, attributes, params) => {
      const result = await run('svg', 'png', SVG(attributes), params);
      expect(result.failure).toBe('image_too_large');
    });

    it('accepts the largest allowed output', async () => {
      const result = await run('svg', 'jpeg', SVG('width="10" height="10"'), {
        width: 4096,
        height: 4096,
      });
      expect(result.outcome).toMatchObject({ ok: true });
    }, 30_000);

    it('rejects an svg that is not well-formed', async () => {
      expect((await run('svg', 'png', '<svg><rect></svg>')).failure).toBe(
        'invalid_input',
      );
      expect((await run('svg', 'png', 'plain text')).failure).toBe(
        'invalid_input',
      );
    });

    it('rejects unsafe svg content before rendering', async () => {
      const result = await run(
        'svg',
        'png',
        SVG('width="10" height="10"', '<script>alert(1)</script>'),
      );
      expect(result.failure).toBe('invalid_input');
      expect(result.data.length).toBe(0);
    });

    it('does not render external images', async () => {
      const result = await run(
        'svg',
        'png',
        SVG(
          'width="10" height="10"',
          '<image href="http://127.0.0.1:1/x.png" width="10" height="10"/>',
        ),
      );
      expect(result.failure).toBe('invalid_input');
    });
  });

  describe('abort', () => {
    it('reports a timeout when aborted before work starts', async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await run(
        'png',
        'jpeg',
        await twoPixels('png'),
        {},
        controller.signal,
      );
      expect(result.failure).toBe('timeout');
      expect(result.data.length).toBe(0);
    });

    it('reports a timeout when aborted during an svg render', async () => {
      const controller = new AbortController();
      const pending = run(
        'svg',
        'png',
        SVG('width="4000" height="4000"'),
        {},
        controller.signal,
      );
      controller.abort();
      const result = await pending;
      expect(result.failure).toBe('timeout');
      expect(result.data.length).toBe(0);
    });
  });

  it('exposes its direction and type', () => {
    const converter = new ImageConverter('svg', 'png', LIMITS);
    expect([converter.type, converter.source, converter.target]).toEqual([
      'image',
      'svg',
      'png',
    ]);
  });
});
