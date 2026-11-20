import { ConverterFailure } from '@/modules/transformations/services/converter';

import { assertJsonCompatible, parseJson, stringifyJson } from './json-model';

describe('json-model', () => {
  it('parses and pretty prints', () => {
    const value = parseJson('{"a":[1,"два",null,true],"b":{"c":1.5}}');
    expect(value).toEqual({ a: [1, 'два', null, true], b: { c: 1.5 } });
    expect(stringifyJson(value)).toBe(`${JSON.stringify(value, null, 2)}\n`);
  });

  it('accepts a scalar root', () => {
    expect(parseJson('"x"')).toBe('x');
  });

  it.each([
    ['trailing data', '{"a":1} {"b":2}'],
    ['trailing comma', '{"a":1,}'],
    ['comments', '{"a":1 /* c */}'],
    ['single quotes', "{'a':1}"],
    ['NaN', '{"a":NaN}'],
    ['Infinity', '{"a":Infinity}'],
    ['duplicate keys', '{"a":1,"a":2}'],
    ['nested duplicate keys', '{"x":{"a":1,"a":2}}'],
    ['plain text', 'hello'],
  ])('rejects %s', (_label, text) => {
    expect(() => parseJson(text)).toThrow(ConverterFailure);
  });

  it('rejects numbers that JSON cannot carry and too deep documents', () => {
    expect(() => assertJsonCompatible(Number.NaN)).toThrow(ConverterFailure);
    expect(() => assertJsonCompatible(undefined)).toThrow(ConverterFailure);
    expect(() => assertJsonCompatible(() => 1)).toThrow(ConverterFailure);
    const deep = '['.repeat(300) + ']'.repeat(300);
    expect(() => parseJson(deep)).toThrow(ConverterFailure);
  });
});
