import { Injectable } from '@nestjs/common';

import { isFormat, normalizeFormat, pairKey } from '../utils/formats';
import type { Converter } from './converter';

export interface Direction {
  type: Converter['type'];
  source: string;
  target: string;
}

/**
 * Finds the converter of a `(source, target)` pair. Converters register
 * themselves on module init. A new format is a new converter and one
 * `register` call: no existing branch changes. Each direction has exactly one
 * converter; a second registration is a startup error, not a silent override.
 */
@Injectable()
export class ConverterRegistry {
  private readonly converters = new Map<string, Converter>();

  register(converter: Converter): void {
    const source = normalizeFormat(converter.source);
    const target = normalizeFormat(converter.target);
    if (!isFormat(source) || !isFormat(target)) {
      throw new Error('Converter has an invalid format name');
    }
    const key = pairKey(source, target);
    if (this.converters.has(key)) {
      throw new Error(`A converter for ${source} -> ${target} already exists`);
    }
    this.converters.set(key, converter);
  }

  find(source: string, target: string): Converter | undefined {
    return this.converters.get(
      pairKey(normalizeFormat(source), normalizeFormat(target)),
    );
  }

  /** Published directions, stable order; optionally of one type. */
  directions(type?: Converter['type']): Direction[] {
    return [...this.converters.values()]
      .filter((converter) => !type || converter.type === type)
      .map(({ type: kind, source, target }) => ({
        type: kind,
        source: normalizeFormat(source),
        target: normalizeFormat(target),
      }))
      .sort((a, b) =>
        pairKey(a.source, a.target).localeCompare(pairKey(b.source, b.target)),
      );
  }
}
