import type { ConfigService } from '@/core/config/config.service';
import { ConverterRegistry } from '@/modules/transformations/services/converter.registry';

import {
  DEFAULT_IMAGE_MAX_INPUT_BYTES,
  IMAGE_MAX_OUTPUT_BYTES,
  IMAGE_TIMEOUT_MS,
  ImageConvertersService,
} from './image-converters.service';

const make = (values: Record<string, unknown> = {}) => {
  const registry = new ConverterRegistry();
  const config = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
  return { registry, service: new ImageConvertersService(registry, config) };
};

describe('ImageConvertersService', () => {
  it('registers the four directions with the default limits', () => {
    const { registry, service } = make();
    service.onModuleInit();

    expect(
      registry.directions().map(({ source, target }) => `${source}>${target}`),
    ).toEqual(['jpeg>png', 'png>jpeg', 'svg>jpeg', 'svg>png']);
    expect(registry.find('png', 'jpeg')?.limits).toEqual({
      maxInputBytes: 10 * 1024 * 1024,
      maxOutputBytes: IMAGE_MAX_OUTPUT_BYTES,
      timeoutMs: 30_000,
    });
    expect(DEFAULT_IMAGE_MAX_INPUT_BYTES).toBe(10 * 1024 * 1024);
    expect(IMAGE_TIMEOUT_MS).toBe(30_000);
  });

  it('has separate configurable limits for png, jpeg and svg', () => {
    const { registry, service } = make({
      TRANSFORM_PNG_MAX_INPUT_BYTES: '2048',
      TRANSFORM_JPEG_MAX_INPUT_BYTES: '3072',
      TRANSFORM_SVG_MAX_INPUT_BYTES: '4096',
    });
    service.onModuleInit();

    expect(registry.find('png', 'jpeg')?.limits.maxInputBytes).toBe(2048);
    expect(registry.find('jpeg', 'png')?.limits.maxInputBytes).toBe(3072);
    expect(registry.find('svg', 'png')?.limits.maxInputBytes).toBe(4096);
    expect(registry.find('svg', 'jpeg')?.limits.maxInputBytes).toBe(4096);
    expect(service.maxInputBytes).toBe(4096);
  });

  it.each([['nope'], [0], [-5], [1.5], [undefined]])(
    'falls back to the default for %p',
    (value) => {
      const { service } = make({
        TRANSFORM_PNG_MAX_INPUT_BYTES: value,
        TRANSFORM_JPEG_MAX_INPUT_BYTES: value,
        TRANSFORM_SVG_MAX_INPUT_BYTES: value,
      });
      expect(service.maxPngBytes).toBe(DEFAULT_IMAGE_MAX_INPUT_BYTES);
      expect(service.maxJpegBytes).toBe(DEFAULT_IMAGE_MAX_INPUT_BYTES);
      expect(service.maxSvgBytes).toBe(DEFAULT_IMAGE_MAX_INPUT_BYTES);
    },
  );

  it('does not support raster -> svg, unknown formats or the same format', () => {
    const { service } = make();
    service.onModuleInit();

    expect(service.isSupported('png', 'jpeg')).toBe(true);
    expect(service.isSupported('svg', 'png')).toBe(true);
    expect(service.isSupported('png', 'svg')).toBe(false);
    expect(service.isSupported('jpeg', 'svg')).toBe(false);
    expect(service.isSupported('png', 'png')).toBe(false);
    expect(service.isSupported('svg', 'svg')).toBe(false);
    expect(service.isSupported('png', 'gif')).toBe(false);
  });

  it('does not treat a text direction as an image direction', () => {
    const { registry, service } = make();
    service.onModuleInit();
    registry.register({
      type: 'file',
      source: 'csv',
      target: 'json',
      limits: { maxInputBytes: 1, maxOutputBytes: 1, timeoutMs: 1 },
      convert: jest.fn(),
    } as never);

    expect(service.isSupported('csv', 'json')).toBe(false);
    expect(service.formats().map(({ source }) => source)).toEqual([
      'png',
      'jpeg',
      'svg',
    ]);
  });

  it('lists the directions in a fixed order', () => {
    const { service } = make();
    service.onModuleInit();
    expect(service.formats()).toEqual([
      { source: 'png', target: ['jpeg'] },
      { source: 'jpeg', target: ['png'] },
      { source: 'svg', target: ['png', 'jpeg'] },
    ]);
  });
});
