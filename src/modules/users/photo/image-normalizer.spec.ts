import {
  BadRequestException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import sharp from 'sharp';

import { ImageNormalizer, sniffContainer } from './image-normalizer';

const solid = (width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 20, g: 120, b: 220 },
    },
  });

const png = (w: number, h: number) => solid(w, h).png().toBuffer();

/** Inserts an `acTL` chunk before the first IDAT: that is what makes a PNG animated. */
function toApng(data: Buffer): Buffer {
  const idat = data.indexOf('IDAT') - 4;
  const chunk = Buffer.alloc(8 + 8 + 4);
  chunk.writeUInt32BE(8, 0);
  chunk.write('acTL', 4, 'latin1');
  chunk.writeUInt32BE(2, 8);
  return Buffer.concat([data.subarray(0, idat), chunk, data.subarray(idat)]);
}

const chunk = (fourcc: string, payload: Buffer): Buffer => {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'latin1');
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([
    head,
    payload,
    payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0),
  ]);
};
const le24 = (n: number) =>
  Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255]);

/** A WebP container with two ANMF frames, assembled by hand (sharp cannot author one here). */
async function animatedWebp(size = 64): Promise<Buffer> {
  const still = await solid(size, size).webp({ lossless: true }).toBuffer();
  const frame = still.subarray(12); // the lone VP8L chunk of the simple format
  const anmf = chunk(
    'ANMF',
    Buffer.concat([
      le24(0),
      le24(0),
      le24(size - 1),
      le24(size - 1),
      le24(100),
      Buffer.from([0]),
      frame,
    ]),
  );
  const vp8x = chunk(
    'VP8X',
    Buffer.concat([
      Buffer.from([0x02, 0, 0, 0]),
      le24(size - 1),
      le24(size - 1),
    ]),
  );
  const anim = chunk('ANIM', Buffer.alloc(6));
  const body = Buffer.concat([Buffer.from('WEBP'), vp8x, anim, anmf, anmf]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

describe('sniffContainer', () => {
  it('detects JPEG, PNG and WebP by signature', async () => {
    expect(sniffContainer(await solid(8, 8).jpeg().toBuffer())).toBe('jpeg');
    expect(sniffContainer(await png(8, 8))).toBe('png');
    expect(sniffContainer(await solid(8, 8).webp().toBuffer())).toBe('webp');
  });

  it('returns null for anything else, including short input', () => {
    expect(sniffContainer(Buffer.from('GIF89a......'))).toBeNull();
    expect(sniffContainer(Buffer.alloc(0))).toBeNull();
    expect(sniffContainer(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(sniffContainer(Buffer.from('RIFF....WAVE'))).toBeNull();
  });
});

describe('ImageNormalizer', () => {
  const normalizer = new ImageNormalizer();

  it('fits a large image into 1024x1024 keeping proportions, as a single WebP', async () => {
    const out = await normalizer.normalize(await png(3000, 1500), 'image/png');

    const meta = await sharp(out).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 1024, height: 512 });
    expect(meta.pages ?? 1).toBe(1);
    expect(out.length).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it('does not enlarge a small image', async () => {
    const out = await normalizer.normalize(await png(200, 100), 'image/png');

    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([200, 100]);
  });

  it('applies the EXIF orientation', async () => {
    const jpeg = await solid(200, 100)
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const out = await normalizer.normalize(jpeg, 'image/jpeg');

    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([100, 200]);
    expect(meta.orientation).toBeUndefined();
  });

  it('strips all metadata', async () => {
    const jpeg = await solid(100, 100)
      .jpeg()
      .withExif({ IFD0: { Copyright: 'secret-owner' } })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();

    const out = await normalizer.normalize(jpeg, 'image/jpeg');

    const meta = await sharp(out).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(out.includes(Buffer.from('secret-owner'))).toBe(false);
  });

  it('accepts a WebP upload and an upper-case declared type', async () => {
    const webp = await solid(100, 100).webp().toBuffer();

    await expect(
      normalizer.normalize(webp, 'IMAGE/WEBP'),
    ).resolves.toBeInstanceOf(Buffer);
  });

  it('accepts the exact limits 64x64 and 4096 on one side', async () => {
    await expect(
      normalizer.normalize(await png(64, 64), 'image/png'),
    ).resolves.toBeInstanceOf(Buffer);
    const wide = await normalizer.normalize(await png(4096, 64), 'image/png');
    expect((await sharp(wide).metadata()).width).toBe(1024);
  });

  it.each([
    ['a GIF', Buffer.from('GIF89a......'), 'image/gif'],
    ['unknown bytes', Buffer.from('not an image at all'), 'image/png'],
    ['an empty file', Buffer.alloc(0), 'image/png'],
  ])('answers 415 for %s', async (_label, data, mime) => {
    await expect(normalizer.normalize(data, mime)).rejects.toBeInstanceOf(
      UnsupportedMediaTypeException,
    );
  });

  it('answers 415 when the declared MIME does not match the signature', async () => {
    await expect(
      normalizer.normalize(await png(100, 100), 'image/jpeg'),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
  });

  it('answers 400 for a truncated (corrupt) image', async () => {
    const good = await png(300, 300);

    await expect(
      normalizer.normalize(
        good.subarray(0, Math.floor(good.length / 2)),
        'image/png',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers 400 for a valid signature with garbage after it', async () => {
    const garbage = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(64, 7),
    ]);

    await expect(
      normalizer.normalize(garbage, 'image/jpeg'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['too narrow', 63, 200],
    ['too short', 200, 63],
    ['tiny', 32, 32],
  ])('answers 400 for an image that is %s', async (_label, w, h) => {
    await expect(
      normalizer.normalize(await png(w, h), 'image/png'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers 400 for an image above 4096 pixels on a side', async () => {
    await expect(
      normalizer.normalize(await png(4097, 64), 'image/png'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers 400 for an animated PNG', async () => {
    const apng = toApng(await png(100, 100));

    await expect(normalizer.normalize(apng, 'image/png')).rejects.toThrow(
      /Animated/,
    );
  });

  it('answers 400 for an animated WebP', async () => {
    const animated = await animatedWebp();
    expect((await sharp(animated, { animated: true }).metadata()).pages).toBe(
      2,
    );

    await expect(normalizer.normalize(animated, 'image/webp')).rejects.toThrow(
      /Animated/,
    );
  });

  it('keeps a noisy image within 2 MiB', async () => {
    const side = 1024;
    const noise = Buffer.alloc(side * side * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    const input = await sharp(noise, {
      raw: { width: side, height: side, channels: 3 },
    })
      .png()
      .toBuffer();

    const out = await normalizer.normalize(input, 'image/png');

    expect(out.length).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
});
