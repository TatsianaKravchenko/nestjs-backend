import { ConverterFailure } from '@/modules/transformations/services/converter';

import {
  csvToXmlTree,
  parseXml,
  stringifyXml,
  xmlTreeToCsvRows,
} from './xml-model';

describe('xml-model', () => {
  describe('parseXml', () => {
    it('uses @attribute, #text and arrays for repeated elements', () => {
      const tree = parseXml(
        '<?xml version="1.0"?><root id="7"><item>1</item><item>2</item><name lang="ru">Анна</name><empty/></root>',
      );
      expect(tree).toEqual({
        root: {
          '@id': '7',
          item: ['1', '2'],
          name: { '@lang': 'ru', '#text': 'Анна' },
          empty: '',
        },
      });
    });

    it('decodes the predefined entities and CDATA', () => {
      expect(parseXml('<a>x &amp; y &lt;z&gt;</a>')).toEqual({
        a: 'x & y <z>',
      });
      expect(parseXml('<a><![CDATA[<b>]]></a>')).toEqual({ a: '<b>' });
    });

    it.each([
      [
        'a DTD with an external entity',
        '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>',
      ],
      [
        'an internal entity (billion laughs)',
        '<!DOCTYPE r [<!ENTITY a "aaa">]><r>&a;</r>',
      ],
      ['a lowercase doctype', '<!doctype r><r/>'],
      ['mismatched tags', '<a><b></a></b>'],
      ['an unclosed tag', '<a>'],
      ['plain text', 'hello'],
      ['several roots', '<a/><b/>'],
    ])('rejects %s', (_label, text) => {
      expect(() => parseXml(text)).toThrow(ConverterFailure);
    });
  });

  describe('stringifyXml', () => {
    it('writes attributes, text and repeated elements', () => {
      const xml = stringifyXml({
        root: {
          '@id': 7,
          item: ['a', 'b'],
          name: { '@lang': 'ru', '#text': 'Анна' },
          flag: true,
          none: null,
        },
      });
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(
        true,
      );
      expect(parseXml(xml)).toEqual({
        root: {
          '@id': '7',
          item: ['a', 'b'],
          name: { '@lang': 'ru', '#text': 'Анна' },
          flag: 'true',
          none: '',
        },
      });
    });

    it('escapes markup in text and attributes', () => {
      const xml = stringifyXml({
        a: { '@q': 'say "hi" & <go>', '#text': '<b>&' },
      });
      expect(parseXml(xml)).toEqual({
        a: { '@q': 'say "hi" & <go>', '#text': '<b>&' },
      });
    });

    it.each([
      ['a non-object root', 'x'],
      ['an array root', [{ a: 1 }]],
      ['two roots', { a: 1, b: 2 }],
      ['an array as the root element', { a: [1, 2] }],
      ['an attribute as the root', { '@a': 1 }],
      ['an invalid element name', { 'a b': 1 }],
      ['an invalid nested name', { a: { '1x': 1 } }],
      ['an invalid attribute name', { a: { '@bad name': 1 } }],
      ['an object attribute', { a: { '@x': { y: 1 } } }],
      ['an object #text', { a: { '#text': { y: 1 } } }],
      ['nested arrays', { a: [[1]] }],
      ['a control character', { a: '\u0000' }],
    ])('rejects %s', (_label, value) => {
      expect(() => stringifyXml(value as never)).toThrow(ConverterFailure);
    });

    it('rejects a tree that is too deep', () => {
      let tree: unknown = 'x';
      for (let i = 0; i < 150; i += 1) tree = { n: tree };
      expect(() => stringifyXml(tree as never)).toThrow(ConverterFailure);
    });
  });

  describe('CSV <-> XML', () => {
    const rows = [
      { name: ' Анна ', age: '001' },
      { name: 'Bob', age: '' },
    ];

    it('maps rows to rows/row/field[name] and back, keeping spaces', () => {
      const xml = stringifyXml(csvToXmlTree(rows));
      expect(xml).toContain('<field name="age">001</field>');
      expect(xmlTreeToCsvRows(parseXml(xml, true))).toEqual(rows);
    });

    it('accepts a single row', () => {
      const tree = parseXml(
        '<rows><row><field name="a">1</field></row></rows>',
        true,
      );
      expect(xmlTreeToCsvRows(tree)).toEqual([{ a: '1' }]);
    });

    it.each([
      ['another root', '<data><row><field name="a">1</field></row></data>'],
      ['no rows', '<rows/>'],
      ['a row without fields', '<rows><row/></rows>'],
      ['a field without a name', '<rows><row><field>1</field></row></rows>'],
      ['an empty name', '<rows><row><field name="">1</field></row></rows>'],
      [
        'a duplicate name',
        '<rows><row><field name="a">1</field><field name="a">2</field></row></rows>',
      ],
      [
        'different columns',
        '<rows><row><field name="a">1</field></row><row><field name="b">1</field></row></rows>',
      ],
      [
        'nested content in a field',
        '<rows><row><field name="a"><x>1</x></field></row></rows>',
      ],
    ])('rejects %s', (_label, xml) => {
      expect(() => xmlTreeToCsvRows(parseXml(xml, true))).toThrow(
        ConverterFailure,
      );
    });
  });
});
