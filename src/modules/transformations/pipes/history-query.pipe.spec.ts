import { BadRequestException } from '@nestjs/common';

import { ConverterRegistry } from '../services/converter.registry';
import { HistoryQueryPipe } from './history-query.pipe';

const registry = {
  directions: () => [
    { type: 'file', source: 'csv', target: 'json' },
    { type: 'image', source: 'png', target: 'jpeg' },
  ],
} as unknown as ConverterRegistry;
const pipe = new HistoryQueryPipe(registry);

describe('HistoryQueryPipe', () => {
  it('defaults: limit 20, every filter null', () => {
    expect(pipe.transform({})).toEqual({
      cursor: undefined,
      limit: 20,
      filters: {
        type: null,
        sourceFormat: null,
        targetFormat: null,
        status: null,
        createdAtFrom: null,
        createdAtTo: null,
      },
    });
    expect(pipe.transform(undefined).limit).toBe(20);
  });

  it('accepts and normalizes every filter', () => {
    const query = pipe.transform({
      cursor: 'abc',
      limit: '100',
      type: 'image',
      sourceFormat: ' PNG ',
      targetFormat: 'jpeg',
      status: 'error',
      createdAtFrom: '2026-01-01T02:00:00+02:00',
      createdAtTo: '2026-01-02T00:00:00.5Z',
    });
    expect(query).toEqual({
      cursor: 'abc',
      limit: 100,
      filters: {
        type: 'image',
        sourceFormat: 'png',
        targetFormat: 'jpeg',
        status: 'error',
        createdAtFrom: '2026-01-01T00:00:00.000Z',
        createdAtTo: '2026-01-02T00:00:00.500Z',
      },
    });
  });

  it.each([
    ['unknown parameter', { userId: 'x' }],
    ['repeated parameter', { limit: ['1', '2'] }],
    ['limit 0', { limit: '0' }],
    ['limit above 100 (no clamping)', { limit: '101' }],
    ['limit with exponent', { limit: '1e1' }],
    ['limit signed', { limit: '+5' }],
    ['limit decimal', { limit: '5.0' }],
    ['unknown type', { type: 'video' }],
    ['unknown status', { status: 'pending' }],
    ['empty cursor', { cursor: '' }],
    ['unsupported source format', { sourceFormat: 'xml' }],
    ['unsupported target format', { targetFormat: 'png' }],
    ['malformed format', { sourceFormat: '../etc' }],
    ['date without zone', { createdAtFrom: '2026-01-01T00:00:00' }],
    ['date only', { createdAtTo: '2026-01-01' }],
    ['impossible date', { createdAtFrom: '2026-02-30T00:00:00Z' }],
    ['month 13', { createdAtFrom: '2026-13-01T00:00:00Z' }],
    ['hour 24', { createdAtTo: '2026-01-01T24:00:00Z' }],
    ['minute 60', { createdAtTo: '2026-01-01T00:60:00Z' }],
    ['offset hour 25', { createdAtTo: '2026-01-01T00:00:00+25:00' }],
    ['offset minute 60', { createdAtTo: '2026-01-01T00:00:00+01:60' }],
    [
      'equal bounds',
      {
        createdAtFrom: '2026-01-01T00:00:00Z',
        createdAtTo: '2026-01-01T00:00:00Z',
      },
    ],
    [
      'inverted bounds',
      {
        createdAtFrom: '2026-01-02T00:00:00Z',
        createdAtTo: '2026-01-01T00:00:00Z',
      },
    ],
  ])('rejects %s with 400', (_name, input) => {
    expect(() => pipe.transform(input)).toThrow(BadRequestException);
  });
});
