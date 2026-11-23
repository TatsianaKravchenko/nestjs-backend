import { Injectable, OnModuleInit } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';
import { TransformationType } from '@/modules/transformations/entities/transformation.entity';
import type { ConverterLimits } from '@/modules/transformations/services/converter';
import { ConverterRegistry } from '@/modules/transformations/services/converter.registry';

import {
  IMAGE_SOURCES,
  IMAGE_TARGETS,
  ImageConverter,
  type ImageSource,
} from './image-converter';

export const DEFAULT_IMAGE_MAX_INPUT_BYTES = 10 * 1024 * 1024;
/** 4096 x 4096 RGBA is 64 MiB raw; a PNG of it is never larger. */
export const IMAGE_MAX_OUTPUT_BYTES = 80 * 1024 * 1024;
export const IMAGE_TIMEOUT_MS = 30_000;

/** The published directions: png -> jpeg, jpeg -> png, svg -> png | jpeg. */
const DIRECTIONS: Record<
  ImageSource,
  readonly (typeof IMAGE_TARGETS)[number][]
> = {
  png: ['jpeg'],
  jpeg: ['png'],
  svg: ['png', 'jpeg'],
};

/** Registers the four image directions. */
@Injectable()
export class ImageConvertersService implements OnModuleInit {
  constructor(
    private readonly registry: ConverterRegistry,
    private readonly config: ConfigService,
  ) {}

  private limit(
    key:
      | 'TRANSFORM_PNG_MAX_INPUT_BYTES'
      | 'TRANSFORM_JPEG_MAX_INPUT_BYTES'
      | 'TRANSFORM_SVG_MAX_INPUT_BYTES',
  ) {
    const configured = Number(this.config.get(key));
    return Number.isInteger(configured) && configured > 0
      ? configured
      : DEFAULT_IMAGE_MAX_INPUT_BYTES;
  }

  /** Input limit of PNG files (`TRANSFORM_PNG_MAX_INPUT_BYTES`). */
  get maxPngBytes(): number {
    return this.limit('TRANSFORM_PNG_MAX_INPUT_BYTES');
  }

  /** Input limit of JPEG files (`TRANSFORM_JPEG_MAX_INPUT_BYTES`). */
  get maxJpegBytes(): number {
    return this.limit('TRANSFORM_JPEG_MAX_INPUT_BYTES');
  }

  /** Input limit of SVG files (`TRANSFORM_SVG_MAX_INPUT_BYTES`). */
  get maxSvgBytes(): number {
    return this.limit('TRANSFORM_SVG_MAX_INPUT_BYTES');
  }

  /** What the upload reader accepts; each direction then applies its own limit. */
  get maxInputBytes(): number {
    return Math.max(this.maxPngBytes, this.maxJpegBytes, this.maxSvgBytes);
  }

  private maxBytesOf(source: ImageSource): number {
    if (source === 'png') return this.maxPngBytes;
    if (source === 'jpeg') return this.maxJpegBytes;
    return this.maxSvgBytes;
  }

  onModuleInit(): void {
    for (const source of IMAGE_SOURCES) {
      const limits: ConverterLimits = {
        maxInputBytes: this.maxBytesOf(source),
        maxOutputBytes: IMAGE_MAX_OUTPUT_BYTES,
        timeoutMs: IMAGE_TIMEOUT_MS,
      };
      for (const target of DIRECTIONS[source]) {
        this.registry.register(new ImageConverter(source, target, limits));
      }
    }
  }

  isSupported(source: string, target: string): boolean {
    return (
      this.registry.find(source, target)?.type === TransformationType.IMAGE
    );
  }

  /** The published directions, grouped by source, in a fixed order. */
  formats(): { source: string; target: string[] }[] {
    const groups = new Map<string, string[]>();
    for (const { source, target } of this.registry.directions(
      TransformationType.IMAGE,
    )) {
      groups.set(source, [...(groups.get(source) ?? []), target]);
    }
    return IMAGE_SOURCES.filter((source) => groups.has(source)).map(
      (source) => ({
        source,
        target: IMAGE_TARGETS.filter((target) =>
          groups.get(source)?.includes(target),
        ),
      }),
    );
  }
}
