import type { ConfigService } from '@/core/config/config.service';
import { ConverterRegistry } from '@/modules/transformations/services/converter.registry';

import {
  DEFAULT_TEXT_MAX_INPUT_BYTES,
  TEXT_MAX_OUTPUT_BYTES,
  TEXT_TIMEOUT_MS,
  TextConvertersService,
} from './text-converters.service';

const make = (configured?: unknown) => {
  const registry = new ConverterRegistry();
  const config = {
    get: jest.fn().mockReturnValue(configured),
  } as unknown as ConfigService;
  return { registry, service: new TextConvertersService(registry, config) };
};

describe('TextConvertersService', () => {
  it('registers the 12 directions with the default limits', () => {
    const { registry, service } = make();
    service.onModuleInit();

    expect(registry.directions()).toHaveLength(12);
    const converter = registry.find('csv', 'json');
    expect(converter?.limits).toEqual({
      maxInputBytes: DEFAULT_TEXT_MAX_INPUT_BYTES,
      maxOutputBytes: TEXT_MAX_OUTPUT_BYTES,
      timeoutMs: TEXT_TIMEOUT_MS,
    });
    expect(DEFAULT_TEXT_MAX_INPUT_BYTES).toBe(10 * 1024 * 1024);
    expect(TEXT_MAX_OUTPUT_BYTES).toBe(50 * 1024 * 1024);
    expect(TEXT_TIMEOUT_MS).toBe(30_000);
  });

  it('uses the configured input limit', () => {
    const { registry, service } = make('2048');
    service.onModuleInit();
    expect(service.maxInputBytes).toBe(2048);
    expect(registry.find('xml', 'yaml')?.limits.maxInputBytes).toBe(2048);
  });

  it.each([['nope'], [0], [-5], [1.5], [undefined]])(
    'falls back to the default for %p',
    (value) => {
      expect(make(value).service.maxInputBytes).toBe(
        DEFAULT_TEXT_MAX_INPUT_BYTES,
      );
    },
  );

  it('lists the directions grouped by source', () => {
    const { service } = make();
    service.onModuleInit();
    expect(service.formats()).toEqual([
      { source: 'csv', target: ['json', 'xml', 'yaml'] },
      { source: 'json', target: ['csv', 'xml', 'yaml'] },
      { source: 'xml', target: ['csv', 'json', 'yaml'] },
      { source: 'yaml', target: ['csv', 'json', 'xml'] },
    ]);
  });
});
