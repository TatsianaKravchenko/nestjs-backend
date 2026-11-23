import { ConverterFailure } from '@/modules/transformations/services/converter';

import { sanitizeSvg } from './svg-sanitizer';

const BOM = String.fromCharCode(0xfeff);
const NS = 'xmlns="http://www.w3.org/2000/svg"';
const XLINK = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
const svg = (body: string, attributes = '') =>
  `<svg ${NS} ${XLINK} ${attributes}>${body}</svg>`;

const rejected = (input: string | Buffer): string | undefined => {
  try {
    sanitizeSvg(Buffer.from(input));
  } catch (error) {
    return error instanceof ConverterFailure ? error.code : 'unexpected';
  }
  return undefined;
};

describe('sanitizeSvg', () => {
  describe('accepts', () => {
    it.each([
      ['a plain drawing', svg('<rect width="1" height="1" fill="red"/>')],
      [
        'the xml declaration',
        `<?xml version="1.0" encoding="UTF-8"?>${svg('<g/>')}`,
      ],
      ['a utf-8 BOM', `${BOM}${svg('<g/>')}`],
      ['comments', svg('<!-- hello --><g/>')],
      [
        'local references',
        svg(
          '<defs><linearGradient id="a"/></defs><rect fill="url(#a)"/><use href="#a"/><use xlink:href="#a"/>',
        ),
      ],
      ['a local style', svg('<style>.a{fill:url(#g)}</style><g class="a"/>')],
      [
        'a style attribute with a local url',
        svg('<g style="fill:url(\'#g\')"/>'),
      ],
      [
        'an embedded png',
        svg('<image href="data:image/png;base64,iVBORw0KGgo="/>'),
      ],
      [
        'a prefixed svg namespace',
        `<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:g/></s:svg>`,
      ],
      [
        'text containing "on" words',
        svg('<text>onload = fine, text only</text>'),
      ],
    ])('%s', (_label, input) => {
      expect(rejected(input)).toBeUndefined();
    });

    it('reports whether the root declares a size', () => {
      const known = (attributes: string) =>
        sanitizeSvg(Buffer.from(svg('', attributes))).hasIntrinsicSize;
      expect(known('width="10"')).toBe(true);
      expect(known('height="10"')).toBe(true);
      expect(known('viewBox="0 0 1 1"')).toBe(true);
      expect(known('')).toBe(false);
    });

    it('returns the document text', () => {
      const input = svg('<g/>');
      expect(sanitizeSvg(Buffer.from(input)).text).toBe(input);
    });
  });

  describe('rejects with invalid_input', () => {
    it.each([
      [
        'an XXE entity reading a file',
        `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>${svg('<text>&x;</text>')}`,
      ],
      [
        'an XXE entity calling a URL',
        `<!DOCTYPE svg [<!ENTITY x SYSTEM "http://evil.example/x">]>${svg('<text>&x;</text>')}`,
      ],
      [
        'a billion-laughs entity expansion',
        `<!DOCTYPE svg [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]>${svg('<text>&b;</text>')}`,
      ],
      ['a doctype without entities', `<!DOCTYPE svg>${svg('<g/>')}`],
      ['a lowercase doctype', `<!doctype svg>${svg('<g/>')}`],
      [
        'a doctype with an external subset',
        `<!DOCTYPE svg SYSTEM "http://evil.example/x.dtd">${svg('<g/>')}`,
      ],
      [
        'an xml-stylesheet instruction',
        `<?xml-stylesheet href="http://evil.example/a.css"?>${svg('<g/>')}`,
      ],
      ['a script element', svg('<script>alert(1)</script>')],
      [
        'a script element with a prefix',
        svg('<x:script xmlns:x="http://www.w3.org/2000/svg">1</x:script>'),
      ],
      ['an uppercase SCRIPT element', svg('<SCRIPT>1</SCRIPT>')],
      ['a nested script', svg('<g><g><script href="a.js"/></g></g>')],
      [
        'a foreignObject',
        svg(
          '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>',
        ),
      ],
      ['an iframe', svg('<iframe src="http://evil.example"/>')],
      ['an embed', svg('<embed src="x"/>')],
      ['an object', svg('<object data="x"/>')],
      ['an onload handler', svg('<g/>', 'onload="alert(1)"')],
      ['an onerror handler', svg('<image href="#a" onerror="alert(1)"/>')],
      ['an onclick handler in any case', svg('<g OnClick="alert(1)"/>')],
      ['a javascript: link', svg('<a href="javascript:alert(1)"><g/></a>')],
      [
        'an obfuscated javascript: link',
        svg('<a xlink:href="JaVaScRiPt :alert(1)"><g/></a>'),
      ],
      ['an external image', svg('<image href="http://evil.example/a.png"/>')],
      [
        'an external xlink image',
        svg('<image xlink:href="https://evil.example/a.png"/>'),
      ],
      [
        'a protocol-relative image',
        svg('<image href="//evil.example/a.png"/>'),
      ],
      ['a file image', svg('<image href="file:///etc/passwd"/>')],
      ['a relative image', svg('<image href="a.png"/>')],
      ['an external use', svg('<use href="http://evil.example/a.svg#x"/>')],
      [
        'an embedded svg image',
        svg('<image href="data:image/svg+xml;base64,PHN2Zy8+"/>'),
      ],
      [
        'an embedded html',
        svg('<a href="data:text/html;base64,PGI+"><g/></a>'),
      ],
      ['an external link', svg('<a href="https://evil.example"><g/></a>')],
      [
        'an external stylesheet import',
        svg('<style>@import url(http://evil.example/a.css);</style>'),
      ],
      ['an @import with a string', svg('<style>@import "a.css";</style>')],
      [
        'an external url() in style',
        svg('<style>.a{fill:url(http://evil.example/x)}</style>'),
      ],
      [
        'an external url() in a style attribute',
        svg('<g style="background:url(https://evil.example/x)"/>'),
      ],
      [
        'an external url() in a presentation attribute',
        svg('<rect fill="url(http://evil.example/x#a)"/>'),
      ],
      [
        'a quoted external url()',
        svg('<g style="fill:url(\'//evil.example/x\')"/>'),
      ],
      ['an unbalanced url(', svg('<g style="fill:url(http://evil.example"/>')],
      ['image() in css', svg('<g style="background:image(\'a.png\')"/>')],
      ['xml:base', svg('<g xml:base="http://evil.example/"/>')],
      ['a text root', 'just text'],
      ['an html root', '<html><body/></html>'],
      ['a root that is not svg', '<g/>'],
      ['two roots', `${svg('<g/>')}${svg('<g/>')}`],
      ['unclosed tags', '<svg><g></svg>'],
      ['an empty document', ''],
      ['invalid utf-8', Buffer.from([0x3c, 0x73, 0xff, 0xfe])],
      ['utf-16 text', Buffer.from(`${BOM}${svg('<g/>')}`, 'utf16le')],
    ])('%s', (_label, input) => {
      expect(rejected(input)).toBe('invalid_input');
    });

    it('a too deeply nested document', () => {
      const depth = 400;
      expect(rejected(svg('<g>'.repeat(depth) + '</g>'.repeat(depth)))).toBe(
        'invalid_input',
      );
    });

    it('a document with too many elements', () => {
      expect(rejected(svg('<g/>'.repeat(100_001)))).toBe('invalid_input');
    });
  });

  it('never reports the offending content', () => {
    try {
      sanitizeSvg(Buffer.from(svg('<script>secret-token</script>')));
      throw new Error('expected a failure');
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('secret-token');
    }
  });
});
