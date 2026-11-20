import { ConverterFailure } from '@/modules/transformations/services/converter';

import { parseCsv, stringifyCsv } from './csv-model';

describe('csv-model', () => {
  describe('parseCsv', () => {
    it('keeps every value a string', () => {
      expect(parseCsv('id,flag\n001,true\n2.50,null\n')).toEqual([
        { id: '001', flag: 'true' },
        { id: '2.50', flag: 'null' },
      ]);
    });

    it('handles quotes, commas, newlines and Unicode', () => {
      const rows = parseCsv(
        'name,note\n"Анна, ""Ann""","line1\nline2"\n😀,ok\r\n',
      );
      expect(rows).toEqual([
        { name: 'Анна, "Ann"', note: 'line1\nline2' },
        { name: '😀', note: 'ok' },
      ]);
    });

    it('returns no rows for a header-only file', () => {
      expect(parseCsv('a,b\n')).toEqual([]);
    });

    it.each([
      ['empty header name', 'a,\n1,2\n'],
      ['duplicate header names', 'a,a\n1,2\n'],
      ['too few fields', 'a,b\n1\n'],
      ['too many fields', 'a,b\n1,2,3\n'],
      ['broken quotes', 'a,b\n"1,2\n'],
    ])('rejects %s', (_label, text) => {
      expect(() => parseCsv(text)).toThrow(ConverterFailure);
    });
  });

  describe('stringifyCsv', () => {
    it('writes flat objects with a header and quotes where needed', () => {
      expect(
        stringifyCsv([
          { a: 'x,y', b: 'say "hi"', c: 1, d: true, e: null },
          { a: 'line\nbreak', b: '', c: 2, d: false, e: 'z' },
        ]),
      ).toBe(
        'a,b,c,d,e\n"x,y","say ""hi""",1,true,\n"line\nbreak",,2,false,z\n',
      );
    });

    it.each([
      ['not an array', { a: 1 }],
      ['an empty array', []],
      ['non-object items', [1, 2]],
      ['an empty object', [{}]],
      ['nested objects', [{ a: { b: 1 } }]],
      ['nested arrays', [{ a: [1] }]],
      ['different keys', [{ a: 1 }, { b: 2 }]],
      ['a missing key', [{ a: 1, b: 2 }, { a: 1 }]],
      ['an extra key', [{ a: 1 }, { a: 1, b: 2 }]],
    ])('rejects %s', (_label, value) => {
      expect(() => stringifyCsv(value as never)).toThrow(ConverterFailure);
    });
  });
});
