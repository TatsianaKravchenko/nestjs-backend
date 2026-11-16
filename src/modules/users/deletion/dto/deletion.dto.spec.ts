import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { ConfirmDeletionDto, ResendDeletionDto } from './deletion.dto';

const ID = '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44';
const errors = <T extends object>(Dto: new () => T, value: object) =>
  validateSync(plainToInstance(Dto, value)).map((e) => e.property);

describe('deletion DTOs', () => {
  it('accepts an OTP confirmation and a token confirmation', () => {
    expect(
      errors(ConfirmDeletionDto, { challengeId: ID, code: '123456' }),
    ).toEqual([]);
    expect(errors(ConfirmDeletionDto, { token: `${ID}.secret` })).toEqual([]);
  });

  it.each([
    [{ challengeId: 'nope', code: '123456' }, 'challengeId'],
    [{ challengeId: ID, code: '12345' }, 'code'],
    [{ challengeId: ID, code: 'abcdef' }, 'code'],
    [{ token: 5 }, 'token'],
    [{ token: 'x'.repeat(201) }, 'token'],
  ])('rejects %j', (value, property) => {
    expect(errors(ConfirmDeletionDto, value)).toContain(property);
  });

  it('validates the resend challenge id', () => {
    expect(errors(ResendDeletionDto, { challengeId: ID })).toEqual([]);
    expect(errors(ResendDeletionDto, { challengeId: 'x' })).toEqual([
      'challengeId',
    ]);
    expect(errors(ResendDeletionDto, {})).toEqual(['challengeId']);
  });
});
