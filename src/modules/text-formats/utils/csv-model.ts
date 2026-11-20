import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

import { ConverterFailure } from '@/modules/transformations/services/converter';

import { isObject, type JsonValue } from './json-model';

export type CsvRow = Record<string, string>;

const fail = (): never => {
  throw new ConverterFailure('invalid_input');
};

/** Header names must be non-empty and unique. */
function checkHeader(header: string[]): string[] {
  const seen = new Set<string>();
  for (const name of header) {
    if (name === '' || seen.has(name)) fail();
    seen.add(name);
  }
  return header;
}

/**
 * RFC 4180 CSV with a mandatory header row. Every value stays a string (no
 * type casting, so `001` stays `001`) and every record must have as many fields
 * as the header.
 */
export function parseCsv(text: string): CsvRow[] {
  try {
    return parse(text, {
      columns: checkHeader,
      cast: false,
      skip_empty_lines: true,
      relax_column_count: false,
      relax_quotes: false,
      bom: false,
      // Per record, not detected from the first line: mixed endings stay clean.
      record_delimiter: ['\r\n', '\n'],
    });
  } catch (error) {
    if (error instanceof ConverterFailure) throw error;
    throw new ConverterFailure('invalid_input');
  }
}

const cell = (value: JsonValue): string => {
  if (value === null) return '';
  if (typeof value === 'object') return fail();
  return String(value);
};

/**
 * Accepts an array of flat objects with identical keys. A nested object or
 * array is rejected: it would otherwise end up as `[object Object]`.
 */
export function stringifyCsv(value: JsonValue): string {
  if (!Array.isArray(value) || value.length === 0) fail();
  const records = value as JsonValue[];
  const first = records[0];
  if (!isObject(first)) fail();
  const columns = Object.keys(first as object);
  if (columns.length === 0) fail();
  const known = new Set(columns);

  const rows = records.map((record) => {
    if (!isObject(record)) return fail();
    const keys = Object.keys(record);
    if (keys.length !== columns.length || keys.some((key) => !known.has(key))) {
      fail();
    }
    return columns.map((column) => cell(record[column]));
  });

  return stringify(rows, { header: true, columns, record_delimiter: '\n' });
}
