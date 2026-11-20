import { ConverterFailure } from '@/modules/transformations/services/converter';

import { parseYaml, stringifyYaml } from './yaml-model';

describe('yaml-model', () => {
  it('parses plain YAML 1.2 data', () => {
    expect(
      parseYaml('a: 1\nb: [x, 2.5, true, null]\nc:\n  d: текст\n'),
    ).toEqual({
      a: 1,
      b: ['x', 2.5, true, null],
      c: { d: 'текст' },
    });
  });

  it('writes strings that look like other types quoted, so they survive', () => {
    const text = stringifyYaml({ id: '001', on: 'true', n: 1 });
    expect(parseYaml(text)).toEqual({ id: '001', on: 'true', n: 1 });
  });

  it.each([
    ['a custom tag', 'a: !!js/function "function(){}"'],
    ['an application tag', 'a: !Custom {x: 1}'],
    ['a python object tag', 'a: !!python/object:os.system {}'],
    ['duplicate keys', 'a: 1\na: 2\n'],
    ['several documents', 'a: 1\n---\nb: 2\n'],
    ['a syntax error', 'a: [1, 2\n'],
    ['NaN', 'a: .nan'],
    ['an infinity', 'a: .inf'],
    ['an empty document', '# only a comment\n'],
  ])('rejects %s', (_label, text) => {
    expect(() => parseYaml(text)).toThrow(ConverterFailure);
  });

  it('rejects an alias bomb', () => {
    const levels = ['a: &a0 [x, x, x, x, x, x, x, x, x, x]'];
    for (let i = 1; i < 12; i += 1) {
      const prev = `*a${i - 1}`;
      levels.push(
        `${String.fromCharCode(98 + i)}: &a${i} [${Array(10).fill(prev).join(', ')}]`,
      );
    }
    expect(() => parseYaml(levels.join('\n'))).toThrow(ConverterFailure);
  });

  it('does not create objects from "__proto__" keys', () => {
    const value = parseYaml('__proto__: {polluted: true}\n') as Record<
      string,
      unknown
    >;
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.keys(value)).toEqual(['__proto__']);
  });
});
