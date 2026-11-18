import { BadRequestException } from '@nestjs/common';

import { escapeLike, normalizeSearch } from './user-search';

describe('escapeLike', () => {
  it('escapes backslash, percent and underscore', () => {
    expect(escapeLike('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });
});

describe('normalizeSearch', () => {
  it('keeps an id as is', () => {
    expect(normalizeSearch('id', 'Abc_123-x')).toEqual({
      by: 'id',
      value: 'Abc_123-x',
    });
  });

  it.each(['', 'a b', 'a'.repeat(129), 'ключ', 'a.b'])('rejects id %j', (q) => {
    expect(() => normalizeSearch('id', q)).toThrow(BadRequestException);
  });

  it.each(['$%^', 'abc$', 'a%b', 'a'.repeat(128) + '!'])(
    'rejects id with invalid characters %j (400, before any UUID check)',
    (q) => {
      expect(() => normalizeSearch('id', q)).toThrow(BadRequestException);
    },
  );

  it('accepts a valid non-UUID ASCII id (the service answers with an empty page)', () => {
    expect(normalizeSearch('id', 'user_123').value).toBe('user_123');
    expect(normalizeSearch('id', 'a'.repeat(128)).value).toHaveLength(128);
  });

  it('trims and lowercases an email prefix', () => {
    expect(normalizeSearch('email', '  JaNe@Exa ')).toEqual({
      by: 'email',
      value: 'jane@exa',
    });
  });

  it.each(['ab', 'a'.repeat(255), 'ja ne', 'jané', 'ja\tne', '   '])(
    'rejects email %j',
    (q) => {
      expect(() => normalizeSearch('email', q)).toThrow(BadRequestException);
    },
  );

  it('accepts the 254-character email bound', () => {
    expect(normalizeSearch('email', 'a'.repeat(254)).value).toHaveLength(254);
  });

  it('trims, NFC-normalizes and lowercases a display name', () => {
    // "e" + combining acute (NFD) -> single "é" (NFC)
    const result = normalizeSearch('displayName', '  JOSÉ Ma ');
    expect(result.value).toBe('josé ma');
  });

  it('counts code points, not UTF-16 units', () => {
    const emoji = '😀'.repeat(3); // 3 code points, 6 units
    expect(normalizeSearch('displayName', emoji).value).toBe(emoji);
    expect(() => normalizeSearch('displayName', '😀😀')).toThrow(
      BadRequestException,
    );
    expect(normalizeSearch('displayName', '😀'.repeat(80)).value).toHaveLength(
      160,
    );
    expect(() => normalizeSearch('displayName', '😀'.repeat(81))).toThrow(
      BadRequestException,
    );
  });

  it.each(['ab', 'abc\u0000', 'abc\u001f', 'abc\u007f', 'abc\u009f', '  ab  '])(
    'rejects display name %j',
    (q) => {
      expect(() => normalizeSearch('displayName', q)).toThrow(
        BadRequestException,
      );
    },
  );
});
