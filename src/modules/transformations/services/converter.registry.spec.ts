import type { Converter } from './converter';
import { ConverterRegistry } from './converter.registry';

const make = (
  source: string,
  target: string,
  type: Converter['type'] = 'file' as Converter['type'],
): Converter => ({
  type,
  source,
  target,
  limits: { maxInputBytes: 1, maxOutputBytes: 1, timeoutMs: 1 },
  convert: () => Promise.resolve({ ok: false, code: 'invalid_input' }),
});

describe('ConverterRegistry', () => {
  it('finds a converter by its (source, target) pair', () => {
    const registry = new ConverterRegistry();
    const csv = make('csv', 'json');
    const yaml = make('yaml', 'json');
    registry.register(csv);
    registry.register(yaml);

    expect(registry.find('csv', 'json')).toBe(csv);
    expect(registry.find('yaml', 'json')).toBe(yaml);
  });

  it('is case-insensitive and ignores surrounding spaces', () => {
    const registry = new ConverterRegistry();
    const csv = make('CSV', 'Json');
    registry.register(csv);

    expect(registry.find(' csv ', 'JSON')).toBe(csv);
  });

  it('direction matters: the reverse pair is a different converter', () => {
    const registry = new ConverterRegistry();
    registry.register(make('csv', 'json'));

    expect(registry.find('json', 'csv')).toBeUndefined();
    expect(registry.find('csv', 'xml')).toBeUndefined();
  });

  it('a new pair is added without touching the existing ones', () => {
    const registry = new ConverterRegistry();
    const first = make('csv', 'json');
    registry.register(first);
    registry.register(make('png', 'webp', 'image' as Converter['type']));

    expect(registry.find('csv', 'json')).toBe(first);
    expect(registry.find('png', 'webp')).toBeDefined();
  });

  it('refuses a second converter for the same direction', () => {
    const registry = new ConverterRegistry();
    registry.register(make('csv', 'json'));

    expect(() => registry.register(make('CSV', 'json'))).toThrow(
      'already exists',
    );
  });

  it.each([
    ['', 'json'],
    ['csv', '../json'],
    ['c sv', 'json'],
    ['csv', 'a'.repeat(33)],
  ])('refuses an invalid format name (%j -> %j)', (source, target) => {
    expect(() =>
      new ConverterRegistry().register(make(source, target)),
    ).toThrow('invalid format');
  });

  it('lists the published directions in a stable order, optionally by type', () => {
    const registry = new ConverterRegistry();
    registry.register(make('yaml', 'json'));
    registry.register(make('png', 'webp', 'image' as Converter['type']));
    registry.register(make('csv', 'json'));

    expect(registry.directions().map((d) => `${d.source}>${d.target}`)).toEqual(
      ['csv>json', 'png>webp', 'yaml>json'],
    );
    expect(registry.directions('image' as Converter['type'])).toEqual([
      { type: 'image', source: 'png', target: 'webp' },
    ]);
  });
});
