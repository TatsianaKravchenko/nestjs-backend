import { BadRequestException } from '@nestjs/common';

import { UPDATE_USER_FIELDS, UpdateUserDto } from '../dto/update-user.dto';
import { StrictBodyPipe } from './strict-body.pipe';

describe('StrictBodyPipe', () => {
  const pipe = new StrictBodyPipe(UpdateUserDto, UPDATE_USER_FIELDS);

  it('returns a validated DTO instance', () => {
    const dto = pipe.transform({ displayName: ' Jane ' });

    expect(dto).toBeInstanceOf(UpdateUserDto);
    expect(dto.displayName).toBe('Jane');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'x'],
    ['a number', 5],
    ['an array', []],
    ['an empty object', {}],
  ])('rejects %s with 400', (_label, value) => {
    expect(() => pipe.transform(value)).toThrow(BadRequestException);
  });

  it('rejects an unknown field and names it', () => {
    expect(() => pipe.transform({ displayName: 'a', role: 'admin' })).toThrow(
      /role/,
    );
  });

  it.each(['id', 'photoUrl', 'createdAt', 'updatedAt', 'password', 'roles'])(
    'rejects the forbidden field %s',
    (field) => {
      expect(() => pipe.transform({ displayName: 'a', [field]: 'x' })).toThrow(
        BadRequestException,
      );
    },
  );

  it('rejects a failed constraint and names the property, not the value', () => {
    let message = '';
    try {
      pipe.transform({ email: 'not-an-email' });
    } catch (error) {
      message = (error as BadRequestException).message;
    }

    expect(message).toContain('email');
    expect(message).not.toContain('not-an-email');
  });

  it('accepts an empty object only with allowEmpty', () => {
    const lenient = new StrictBodyPipe(UpdateUserDto, UPDATE_USER_FIELDS, {
      allowEmpty: true,
    });

    expect(lenient.transform({})).toBeInstanceOf(UpdateUserDto);
  });
});
