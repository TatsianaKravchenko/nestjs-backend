import { BadRequestException } from '@nestjs/common';

import { ListUsersQueryPipe } from './list-users-query.pipe';

const pipe = new ListUsersQueryPipe();
const run = (query: unknown) => pipe.transform(query);

describe('ListUsersQueryPipe', () => {
  it('applies the defaults for an empty query', () => {
    expect(run({})).toEqual({
      cursor: undefined,
      limit: 20,
      search: undefined,
      status: undefined,
      sort: 'createdAt',
      order: 'desc',
      paramNames: [],
    });
  });

  it('treats a missing query object as empty', () => {
    expect(run(undefined).limit).toBe(20);
  });

  it('parses every allowed parameter and lists their names sorted', () => {
    const result = run({
      cursor: 'abc.def',
      limit: '100',
      searchBy: 'email',
      q: ' Jane@ ',
      status: 'blocked',
      sort: 'id',
      order: 'asc',
    });
    expect(result).toMatchObject({
      cursor: 'abc.def',
      limit: 100,
      search: { by: 'email', value: 'jane@' },
      status: 'blocked',
      sort: 'id',
      order: 'asc',
      paramNames: [
        'cursor',
        'limit',
        'order',
        'q',
        'searchBy',
        'sort',
        'status',
      ],
    });
  });

  it.each(['pending', 'active', 'blocked', 'deleting', 'deleted'])(
    'accepts status %s',
    (status) => {
      expect(run({ status }).status).toBe(status);
    },
  );

  it.each([
    ['unknown parameter', { foo: '1' }],
    ['bracket syntax', { 'limit[a]': '1' }],
    ['duplicate parameter', { limit: ['1', '2'] }],
    ['limit 0', { limit: '0' }],
    ['limit above 100 (no clamping)', { limit: '101' }],
    ['non-numeric limit', { limit: 'abc' }],
    ['decimal limit', { limit: '5.5' }],
    ['exponent limit', { limit: '1e1' }],
    ['signed limit', { limit: '+5' }],
    ['empty limit', { limit: '' }],
    ['unknown status', { status: 'banned' }],
    ['unknown sort', { sort: 'email' }],
    ['unknown order', { order: 'up' }],
    ['unknown searchBy', { searchBy: 'phone', q: 'abc' }],
    ['searchBy without q', { searchBy: 'id' }],
    ['q without searchBy', { q: 'abc' }],
    ['invalid q for the field', { searchBy: 'email', q: 'ab' }],
    ['id q with invalid characters', { searchBy: 'id', q: '$%^' }],
    ['id q longer than 128', { searchBy: 'id', q: 'a'.repeat(129) }],
    ['empty cursor', { cursor: '' }],
  ])('rejects %s', (_label, query) => {
    expect(() => run(query)).toThrow(BadRequestException);
  });

  it('rejects an uppercase-only difference in enum values', () => {
    expect(() => run({ order: 'ASC' })).toThrow(BadRequestException);
  });
});
