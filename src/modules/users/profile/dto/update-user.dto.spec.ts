import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import {
  ConfirmEmailChangeDto,
  normalizeDisplayName,
  ResendEmailChangeDto,
  StartEmailChangeDto,
  UpdateUserDto,
} from './update-user.dto';

const UUID = '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44';

function check<T extends object>(cls: new () => T, plain: object) {
  const dto = plainToInstance(cls, plain);
  const errors = validateSync(dto, { forbidUnknownValues: true });
  return {
    dto,
    valid: errors.length === 0,
    fields: errors.map((e) => e.property),
  };
}

describe('UpdateUserDto', () => {
  describe('displayName', () => {
    it('trims and NFC-normalizes', () => {
      const { dto, valid } = check(UpdateUserDto, {
        displayName: '  Café  ',
      });

      expect(valid).toBe(true);
      expect(dto.displayName).toBe('Café');
    });

    it('accepts null (clears the name)', () => {
      const { dto, valid } = check(UpdateUserDto, { displayName: null });

      expect(valid).toBe(true);
      expect(dto.displayName).toBeNull();
    });

    it('is optional', () => {
      expect(check(UpdateUserDto, { status: 'active' }).valid).toBe(true);
    });

    it('accepts 80 code points and refuses 81', () => {
      expect(check(UpdateUserDto, { displayName: 'a'.repeat(80) }).valid).toBe(
        true,
      );
      expect(
        check(UpdateUserDto, { displayName: 'a'.repeat(81) }).fields,
      ).toEqual(['displayName']);
    });

    it('counts an astral character as one code point', () => {
      expect(check(UpdateUserDto, { displayName: '😀'.repeat(80) }).valid).toBe(
        true,
      );
      expect(check(UpdateUserDto, { displayName: '😀'.repeat(81) }).valid).toBe(
        false,
      );
    });

    it.each([
      ['empty', ''],
      ['blank after trimming', ' \t\n '],
      ['NUL', 'a\u0000b'],
      ['C0 control', 'a\u001fb'],
      ['DEL', 'a\u007fb'],
      ['C1 control', 'a\u0085b'],
      ['a number', 5],
      ['an object', {}],
    ])('refuses %s', (_label, displayName) => {
      expect(check(UpdateUserDto, { displayName }).fields).toEqual([
        'displayName',
      ]);
    });
  });

  describe('email', () => {
    it('trims and lowercases', () => {
      const { dto, valid } = check(UpdateUserDto, {
        email: '  Jane+Tag@Example.COM ',
      });

      expect(valid).toBe(true);
      expect(dto.email).toBe('jane+tag@example.com');
    });

    it('refuses null, empty and a malformed address', () => {
      for (const email of [null, '', 'nope', 'a@']) {
        expect(check(UpdateUserDto, { email }).fields).toEqual(['email']);
      }
    });

    it('accepts 254 characters and refuses 255', () => {
      const local = (n: number) => `${'a'.repeat(n)}@x.io`;
      // local part max is 64: build with labels instead
      const address = (total: number) => {
        const domain = `${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.`;
        const tld = 'e'.repeat(total - 1 - 20 - domain.length);
        return `${'a'.repeat(20)}@${domain}${tld}`;
      };
      expect(address(254)).toHaveLength(254);
      expect(
        check(UpdateUserDto, { email: address(254) }).fields,
      ).not.toContain('maxLength');
      expect(check(UpdateUserDto, { email: address(255) }).valid).toBe(false);
      expect(local(10)).toContain('@');
    });
  });

  describe('status', () => {
    it.each(['active', 'blocked'])('accepts %s', (status) => {
      expect(check(UpdateUserDto, { status }).valid).toBe(true);
    });

    it.each(['pending', 'deleting', 'deleted', 'ACTIVE', '', null, 1])(
      'refuses %j',
      (status) => {
        expect(check(UpdateUserDto, { status }).fields).toEqual(['status']);
      },
    );
  });
});

describe('normalizeDisplayName', () => {
  it('leaves non-strings to the validators', () => {
    expect(normalizeDisplayName(5)).toBe(5);
    expect(normalizeDisplayName(null)).toBeNull();
  });
});

describe('StartEmailChangeDto', () => {
  it('normalizes newEmail and requires it', () => {
    const ok = check(StartEmailChangeDto, { newEmail: ' New@Example.com ' });

    expect(ok.valid).toBe(true);
    expect(ok.dto.newEmail).toBe('new@example.com');
    expect(check(StartEmailChangeDto, {}).fields).toEqual(['newEmail']);
    expect(check(StartEmailChangeDto, { newEmail: 'bad' }).valid).toBe(false);
  });
});

describe('ResendEmailChangeDto', () => {
  it('requires a uuid-shaped challengeId', () => {
    expect(check(ResendEmailChangeDto, { challengeId: UUID }).valid).toBe(true);
    expect(check(ResendEmailChangeDto, { challengeId: 'x' }).valid).toBe(false);
    expect(check(ResendEmailChangeDto, {}).valid).toBe(false);
  });
});

describe('ConfirmEmailChangeDto', () => {
  it('accepts the OTP form and the token form', () => {
    expect(
      check(ConfirmEmailChangeDto, { challengeId: UUID, code: '012345' }).valid,
    ).toBe(true);
    expect(check(ConfirmEmailChangeDto, { token: `${UUID}.abc` }).valid).toBe(
      true,
    );
  });

  it.each(['12345', '1234567', 'abcdef', '12 456', 5])(
    'refuses the code %j',
    (code) => {
      expect(
        check(ConfirmEmailChangeDto, { challengeId: UUID, code }).fields,
      ).toEqual(['code']);
    },
  );

  it('refuses a malformed challengeId and an over-long token', () => {
    expect(
      check(ConfirmEmailChangeDto, { challengeId: 'x', code: '123456' }).fields,
    ).toEqual(['challengeId']);
    expect(
      check(ConfirmEmailChangeDto, { token: 'a'.repeat(201) }).fields,
    ).toEqual(['token']);
  });

  it('leaves the combination (exactly one variant) to the service', () => {
    expect(check(ConfirmEmailChangeDto, {}).valid).toBe(true);
  });
});
