import { Readable, Writable } from 'stream';

import type { ConversionOutcome } from '@/modules/transformations/services/converter';
import { ConverterFailure } from '@/modules/transformations/services/converter';

import { TEXT_FORMATS, TextConverter, type TextFormat } from './text-converter';

const LIMITS = { maxInputBytes: 1024, maxOutputBytes: 1024, timeoutMs: 1000 };

const SAMPLES: Record<TextFormat, string> = {
  csv: 'name,age\nАнна,001\n"Bob, Jr.","say ""hi"""\n',
  json: '[{"name":"Анна","age":"001"},{"name":"Bob, Jr.","age":"say \\"hi\\""}]',
  yaml: '- name: Анна\n  age: "001"\n- name: Bob, Jr.\n  age: say "hi"\n',
  xml: `<rows>
  <row><field name="name">Анна</field><field name="age">001</field></row>
  <row><field name="name">Bob, Jr.</field><field name="age">say "hi"</field></row>
</rows>`,
};

const ROWS = [
  { name: 'Анна', age: '001' },
  { name: 'Bob, Jr.', age: 'say "hi"' },
];

// Pairs without CSV carry a document with one root element.
const TREE = { r: { '@id': '1', i: ['a', 'b'], n: 't' } };
const TREE_SAMPLES: Record<Exclude<TextFormat, 'csv'>, string> = {
  json: JSON.stringify(TREE),
  yaml: 'r:\n  "@id": "1"\n  i: [a, b]\n  n: t\n',
  xml: '<r id="1"><i>a</i><i>b</i><n>t</n></r>',
};

async function run(
  source: TextFormat,
  target: TextFormat,
  input: string | Buffer,
  options: { aborted?: boolean; limits?: Partial<typeof LIMITS> } = {},
): Promise<{ outcome: ConversionOutcome; text: string }> {
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  const abort = new AbortController();
  if (options.aborted) abort.abort();
  const converter = new TextConverter(source, target, {
    ...LIMITS,
    ...options.limits,
  });
  const outcome = await converter.convert({
    input: Readable.from([Buffer.from(input)]),
    output,
    params: {},
    signal: abort.signal,
  });
  return { outcome, text: Buffer.concat(chunks).toString('utf8') };
}

const failure = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof ConverterFailure ? error.code : 'other';
  }
  return 'none';
};

describe('TextConverter: the 12 directions', () => {
  const pairs = TEXT_FORMATS.flatMap((source) =>
    TEXT_FORMATS.filter((target) => target !== source).map(
      (target) => [source, target] as const,
    ),
  );

  it('has exactly 12 pairs', () => {
    expect(pairs).toHaveLength(12);
  });

  /** Reads a result back into plain data with the converters themselves. */
  async function dataOf(format: TextFormat, text: string, csvPair: boolean) {
    const viaJson = async (from: TextFormat, via: TextFormat, body: string) =>
      JSON.parse((await run(from, via, body)).text) as unknown;
    if (format === 'json') return JSON.parse(text) as unknown;
    if (csvPair && format === 'xml') {
      return viaJson('csv', 'json', (await run('xml', 'csv', text)).text);
    }
    return viaJson(format, 'json', text);
  }

  it.each(pairs)('%s -> %s keeps the data', async (source, target) => {
    const csvPair = source === 'csv' || target === 'csv';
    const input =
      source !== 'csv' && !csvPair ? TREE_SAMPLES[source] : SAMPLES[source];
    const { outcome, text } = await run(source, target, input);

    expect(outcome).toMatchObject({
      ok: true,
      size: Buffer.byteLength(text),
      extension: target,
    });
    expect(await dataOf(target, text, csvPair)).toEqual(csvPair ? ROWS : TREE);
  });

  it.each([
    ['csv', 'json'],
    ['csv', 'yaml'],
  ] as const)('%s -> %s keeps numbers-like text as strings', async (s, t) => {
    const { text } = await run(s, t, 'id\n001\n1e3\n');
    expect(text).toContain('001');
    expect(text).not.toMatch(/: 1\b|: 1000/);
  });

  it('csv -> xml uses rows/row/field[name]', async () => {
    const { text } = await run('csv', 'xml', SAMPLES.csv);
    expect(text).toContain('<rows>');
    expect(text).toContain('<field name="age">001</field>');
    expect(text).toContain('&quot;hi&quot;');
  });

  it('xml -> csv round trips csv exactly', async () => {
    const xml = await run('csv', 'xml', SAMPLES.csv);
    const csv = await run('xml', 'csv', xml.text);
    expect(csv.text).toBe(SAMPLES.csv);
  });

  it('json -> csv round trips csv exactly', async () => {
    const json = await run('csv', 'json', SAMPLES.csv);
    expect((await run('json', 'csv', json.text)).text).toBe(SAMPLES.csv);
  });

  it('xml -> json uses @attribute, #text and arrays', async () => {
    const { text } = await run(
      'xml',
      'json',
      '<r id="1"><i>a</i><i>b</i><n k="v">t</n></r>',
    );
    expect(JSON.parse(text)).toEqual({
      r: { '@id': '1', i: ['a', 'b'], n: { '@k': 'v', '#text': 't' } },
    });
  });

  it('json -> xml -> json is stable', async () => {
    const source = {
      r: { '@id': '1', i: ['a', 'b'], n: { '@k': 'v', '#text': 't' } },
    };
    const xml = await run('json', 'xml', JSON.stringify(source));
    const json = await run('xml', 'json', xml.text);
    expect(JSON.parse(json.text)).toEqual(source);
  });

  it('accepts an initial BOM', async () => {
    const { text } = await run('csv', 'json', `\uFEFFa\n1\n`);
    expect(JSON.parse(text)).toEqual([{ a: '1' }]);
  });
});

describe('TextConverter: failures', () => {
  it.each([
    ['csv', 'json', 'a,a\n1,2\n'],
    ['csv', 'json', 'a,b\n1\n'],
    ['json', 'csv', '{"a":1}'],
    ['json', 'csv', '[{"a":{"b":1}}]'],
    ['json', 'csv', '[{"a":[1]}]'],
    ['json', 'xml', '{"a":1,"b":2}'],
    ['json', 'yaml', '{"a":1,}'],
    ['yaml', 'json', 'a: !!js/function "x"'],
    ['yaml', 'csv', 'a: 1'],
    [
      'xml',
      'json',
      '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>',
    ],
    ['xml', 'csv', '<other/>'],
  ] as const)('%s -> %s rejects bad content (%#)', async (s, t, input) => {
    expect(await failure(run(s, t, input))).toBe('invalid_input');
  });

  it('rejects invalid UTF-8', async () => {
    expect(
      await failure(run('csv', 'json', Buffer.from([0x61, 0x0a, 0xff, 0xfe]))),
    ).toBe('invalid_input');
  });

  it('stops with a timeout code when aborted', async () => {
    expect(await failure(run('csv', 'json', 'a\n1\n', { aborted: true }))).toBe(
      'timeout',
    );
  });

  it('never exposes parser messages or content', async () => {
    const secret = 'TOP-SECRET-VALUE';
    try {
      await run('json', 'csv', `{"x": "${secret}",}`);
      throw new Error('expected a failure');
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(secret);
      expect((error as Error).message).toBe('invalid_input');
    }
  });

  it('fails when the output cannot be written', async () => {
    const converter = new TextConverter('csv', 'json', LIMITS);
    const output = new Writable({
      write(_chunk, _enc, cb) {
        cb(new Error('disk full'));
      },
    });
    output.on('error', () => undefined); // the service's pipeline handles it
    await expect(
      converter.convert({
        input: Readable.from([Buffer.from('a\n1\n')]),
        output,
        params: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('disk full');
  });
});
