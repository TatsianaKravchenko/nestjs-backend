import { Injectable, OnModuleInit } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';
import { TransformationType } from '@/modules/transformations/entities/transformation.entity';
import { ConverterRegistry } from '@/modules/transformations/services/converter.registry';
import type { ConverterLimits } from '@/modules/transformations/services/converter';

import { TEXT_FORMATS, TextConverter } from './text-converter';

export const DEFAULT_TEXT_MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const TEXT_MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
export const TEXT_TIMEOUT_MS = 30_000;

/** Registers the 12 directions between CSV, JSON, XML and YAML. */
@Injectable()
export class TextConvertersService implements OnModuleInit {
  constructor(
    private readonly registry: ConverterRegistry,
    private readonly config: ConfigService,
  ) {}

  /** Input limit of the text conversions (`TRANSFORM_TEXT_MAX_INPUT_BYTES`). */
  get maxInputBytes(): number {
    const configured = Number(
      this.config.get('TRANSFORM_TEXT_MAX_INPUT_BYTES'),
    );
    return Number.isInteger(configured) && configured > 0
      ? configured
      : DEFAULT_TEXT_MAX_INPUT_BYTES;
  }

  onModuleInit(): void {
    const limits: ConverterLimits = {
      maxInputBytes: this.maxInputBytes,
      maxOutputBytes: TEXT_MAX_OUTPUT_BYTES,
      timeoutMs: TEXT_TIMEOUT_MS,
    };
    for (const source of TEXT_FORMATS) {
      for (const target of TEXT_FORMATS) {
        if (source === target) continue;
        this.registry.register(new TextConverter(source, target, limits));
      }
    }
  }

  /** The published directions, grouped by source. */
  formats(): { source: string; target: string[] }[] {
    const groups = new Map<string, string[]>();
    for (const { source, target } of this.registry.directions(
      TransformationType.FILE,
    )) {
      groups.set(source, [...(groups.get(source) ?? []), target]);
    }
    return [...groups].map(([source, target]) => ({ source, target }));
  }
}
