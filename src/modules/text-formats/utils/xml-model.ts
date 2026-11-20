import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';

import { ConverterFailure } from '@/modules/transformations/services/converter';

import type { CsvRow } from './csv-model';
import {
  assertJsonCompatible,
  isObject,
  type JsonObject,
  type JsonValue,
} from './json-model';

const ATTR = '@';
const TEXT = '#text';
const XML_NAME = /^[\p{L}_][\p{L}\p{N}_.-]*$/u;
// Characters XML 1.0 cannot carry at all (not even as character references).
// eslint-disable-next-line no-control-regex
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;
const DOCTYPE = /<!\s*(DOCTYPE|ENTITY)/i;

const fail = (): never => {
  throw new ConverterFailure('invalid_input');
};

// No DTD, no external entities, no network: fast-xml-parser never resolves
// anything outside the document, and a DOCTYPE is refused before parsing.
const PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: ATTR,
  textNodeName: TEXT,
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  processEntities: true,
  htmlEntities: false,
} as const;

const parser = new XMLParser({ ...PARSER_OPTIONS, trimValues: true });
// CSV values keep their surrounding spaces.
const exactParser = new XMLParser({ ...PARSER_OPTIONS, trimValues: false });

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR,
  textNodeName: TEXT,
  format: true,
  indentBy: '  ',
  suppressEmptyNode: false,
  processEntities: true,
});

function checkWellFormed(text: string): void {
  if (DOCTYPE.test(text) || XMLValidator.validate(text) !== true) fail();
}

/** XML -> tree (`@attribute`, `#text`, repeated elements as arrays). */
export function parseXml(text: string, preserveSpace = false): JsonValue {
  checkWellFormed(text);
  const value: unknown = (preserveSpace ? exactParser : parser).parse(text);
  if (!isObject(value) || Object.keys(value).length !== 1) return fail();
  assertJsonCompatible(value);
  return value;
}

function scalar(value: JsonValue): string {
  if (value === null) return '';
  if (typeof value === 'object') return fail();
  const result = String(value);
  if (XML_FORBIDDEN.test(result)) fail();
  return result;
}

/** Normalizes a tree for the builder and rejects what XML cannot express. */
function toXmlNode(value: JsonValue, depth = 0): unknown {
  if (depth > 100) return fail();
  if (!isObject(value)) {
    if (Array.isArray(value)) return fail();
    return scalar(value);
  }
  const node: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith(ATTR)) {
      const name = key.slice(ATTR.length);
      if (!XML_NAME.test(name) || (typeof item === 'object' && item !== null)) {
        return fail();
      }
      node[key] = scalar(item);
    } else if (key === TEXT) {
      if (typeof item === 'object' && item !== null) return fail();
      node[key] = scalar(item);
    } else {
      if (!XML_NAME.test(key)) return fail();
      node[key] = Array.isArray(item)
        ? item.map((entry) => toXmlNode(entry, depth + 1))
        : toXmlNode(item, depth + 1);
    }
  }
  return node;
}

/** Tree -> XML. The tree must have exactly one root element. */
export function stringifyXml(value: JsonValue): string {
  if (!isObject(value)) return fail();
  const keys = Object.keys(value);
  const root = keys[0];
  if (keys.length !== 1 || root === undefined) return fail();
  if (root.startsWith(ATTR) || root === TEXT || Array.isArray(value[root])) {
    return fail();
  }
  const body: string = builder.build(toXmlNode(value));
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}

/** CSV rows -> `<rows><row><field name="col">value</field>...</row></rows>`. */
export function csvToXmlTree(rows: CsvRow[]): JsonObject {
  return {
    rows: {
      row: rows.map((row) => ({
        field: Object.entries(row).map(([name, value]) => ({
          [`${ATTR}name`]: name,
          [TEXT]: value,
        })),
      })),
    },
  };
}

/** True when the object has a key outside `allowed`: not the CSV shape. */
const hasOtherKeys = (value: JsonObject, allowed: string[]): boolean =>
  Object.keys(value).some((key) => !allowed.includes(key));

/**
 * `<rows>` and `<row>` only hold their children: the indentation between them
 * (kept because values are not trimmed) is ignored, other text is an error.
 */
const isStructural = (value: JsonObject, child: string): boolean => {
  const blank = value[TEXT];
  return (
    !hasOtherKeys(value, [child, TEXT]) &&
    (blank === undefined || (typeof blank === 'string' && blank.trim() === ''))
  );
};

const list = (value: JsonValue | undefined): JsonValue[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** The inverse of `csvToXmlTree`; anything else is not a CSV document. */
export function xmlTreeToCsvRows(tree: JsonValue): CsvRow[] {
  const container = isObject(tree) ? tree['rows'] : undefined;
  if (!isObject(container)) return fail();
  const rows = list(container['row']);
  if (rows.length === 0 || !isStructural(container, 'row')) return fail();

  let header: string[] | undefined;
  return rows.map((row) => {
    if (!isObject(row) || !isStructural(row, 'field')) return fail();
    const fields = list(row['field']);
    const record: CsvRow = Object.create(null) as CsvRow;
    for (const field of fields) {
      if (!isObject(field) || hasOtherKeys(field, [`${ATTR}name`, TEXT])) {
        return fail();
      }
      const name = field[`${ATTR}name`];
      const content = field[TEXT] ?? '';
      if (
        typeof name !== 'string' ||
        name === '' ||
        typeof content !== 'string' ||
        Object.hasOwn(record, name)
      ) {
        return fail();
      }
      record[name] = content;
    }
    const names = Object.keys(record);
    header ??= names;
    if (
      names.length === 0 ||
      names.length !== header.length ||
      names.some((name, index) => name !== header?.[index])
    ) {
      return fail();
    }
    return record;
  });
}
