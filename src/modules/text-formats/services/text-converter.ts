import { TransformationType } from '@/modules/transformations/entities/transformation.entity';
import {
  ConverterFailure,
  type ConversionOutcome,
  type ConversionRequest,
  type Converter,
  type ConverterLimits,
} from '@/modules/transformations/services/converter';

import { parseCsv, stringifyCsv } from '../utils/csv-model';
import { parseJson, stringifyJson, type JsonValue } from '../utils/json-model';
import { decodeText, readInput } from '../utils/text-codec';
import {
  csvToXmlTree,
  parseXml,
  stringifyXml,
  xmlTreeToCsvRows,
} from '../utils/xml-model';
import { parseYaml, stringifyYaml } from '../utils/yaml-model';

export const TEXT_FORMATS = ['csv', 'json', 'xml', 'yaml'] as const;
export type TextFormat = (typeof TEXT_FORMATS)[number];

export const TEXT_MEDIA: Record<
  TextFormat,
  { contentType: string; extension: string }
> = {
  csv: { contentType: 'text/csv', extension: 'csv' },
  json: { contentType: 'application/json', extension: 'json' },
  xml: { contentType: 'application/xml', extension: 'xml' },
  yaml: { contentType: 'application/yaml', extension: 'yaml' },
};

/** Source text -> the data model that the target serializer understands. */
function toModel(source: TextFormat, target: TextFormat, text: string) {
  switch (source) {
    case 'csv': {
      const rows = parseCsv(text);
      return target === 'xml' ? csvToXmlTree(rows) : rows;
    }
    case 'xml':
      return target === 'csv'
        ? xmlTreeToCsvRows(parseXml(text, true))
        : parseXml(text);
    case 'json':
      return parseJson(text);
    case 'yaml':
      return parseYaml(text);
  }
}

function serialize(target: TextFormat, model: JsonValue): string {
  switch (target) {
    case 'csv':
      return stringifyCsv(model);
    case 'json':
      return stringifyJson(model);
    case 'xml':
      return stringifyXml(model);
    case 'yaml':
      return stringifyYaml(model);
  }
}

const write = (request: ConversionRequest, data: Buffer): Promise<void> =>
  new Promise((resolve, reject) => {
    request.output.write(data, (error) => (error ? reject(error) : resolve()));
  });

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ConverterFailure('timeout');
}

/**
 * One direction between two text formats. Parsing and serializing are done by
 * maintained libraries; this class only wires them, enforces UTF-8 and checks
 * the abort signal between the (synchronous) steps.
 */
export class TextConverter implements Converter {
  readonly type = TransformationType.FILE;

  constructor(
    readonly source: TextFormat,
    readonly target: TextFormat,
    readonly limits: ConverterLimits,
  ) {}

  async convert(request: ConversionRequest): Promise<ConversionOutcome> {
    const text = decodeText(await readInput(request.input));
    checkAborted(request.signal);
    const model = toModel(this.source, this.target, text) as JsonValue;
    checkAborted(request.signal);
    const result = Buffer.from(serialize(this.target, model), 'utf8');
    checkAborted(request.signal);
    await write(request, result);
    return { ok: true, size: result.length, ...TEXT_MEDIA[this.target] };
  }
}
