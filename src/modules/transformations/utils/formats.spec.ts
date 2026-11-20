import {
  isContentType,
  isExtension,
  isFormat,
  normalizeFormat,
  pairKey,
} from './formats';

describe('format helpers', () => {
  it('normalizes case and spaces', () => {
    expect(normalizeFormat('  CSV ')).toBe('csv');
    expect(pairKey('csv', 'json')).toBe('csv>json');
  });

  it.each(['csv', 'jpeg', 'svg+xml', 'x.y-z', '7z'])(
    'accepts the format %s',
    (v) => expect(isFormat(v)).toBe(true),
  );

  it.each(['', '.hidden', '../x', 'a/b', 'a b', 'A', 'a'.repeat(33), 'a\nb'])(
    'rejects the format %j',
    (v) => expect(isFormat(v)).toBe(false),
  );

  it('accepts only a bare type/subtype as a content type', () => {
    expect(isContentType('application/json')).toBe(true);
    expect(isContentType('image/svg+xml')).toBe(true);
    expect(isContentType('text/plain; charset=utf-8')).toBe(false);
    expect(isContentType('text/plain\r\nX: 1')).toBe(false);
    expect(isContentType('plain')).toBe(false);
  });

  it('accepts only short alphanumeric extensions', () => {
    expect(isExtension('json')).toBe(true);
    expect(isExtension('.json')).toBe(false);
    expect(isExtension('../x')).toBe(false);
    expect(isExtension('')).toBe(false);
    expect(isExtension('a'.repeat(17))).toBe(false);
  });
});
