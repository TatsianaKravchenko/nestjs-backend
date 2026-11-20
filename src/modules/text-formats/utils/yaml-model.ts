import { parseDocument, stringify } from 'yaml';

import { ConverterFailure } from '@/modules/transformations/services/converter';

import { assertJsonCompatible, type JsonValue } from './json-model';

/** Enough for real documents, far below an alias bomb ("billion laughs"). */
const MAX_ALIAS_COUNT = 100;

/**
 * Safe YAML 1.2: the `core` schema only (no custom tags, no object creation,
 * no merge keys), one document, unique keys. Unknown tags and any other
 * warning are errors, so nothing silently becomes a string.
 */
export function parseYaml(text: string): JsonValue {
  try {
    const doc = parseDocument(text, {
      schema: 'core',
      version: '1.2',
      uniqueKeys: true,
      merge: false,
      strict: true,
      prettyErrors: false,
    });
    if (
      doc.contents === null ||
      doc.errors.length > 0 ||
      doc.warnings.length > 0
    ) {
      throw new ConverterFailure('invalid_input');
    }
    const value: unknown = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
    assertJsonCompatible(value);
    return value;
  } catch (error) {
    if (error instanceof ConverterFailure) throw error;
    throw new ConverterFailure('invalid_input');
  }
}

export function stringifyYaml(value: JsonValue): string {
  return stringify(value, { schema: 'core', lineWidth: 0 });
}
