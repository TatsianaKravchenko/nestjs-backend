import type { Readable } from 'stream';

import { ConverterFailure } from '@/modules/transformations/services/converter';

const BOM = '﻿';
const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Reads the whole input (already capped by the service's size limit). */
export async function readInput(input: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Strict UTF-8: invalid byte sequences are an error, a BOM is allowed only at
 * the very start (and removed), and a document with no content is rejected.
 */
export function decodeText(data: Buffer): string {
  let text: string;
  try {
    text = DECODER.decode(data);
  } catch {
    throw new ConverterFailure('invalid_input');
  }
  if (text.startsWith(BOM)) text = text.slice(1);
  if (text.includes(BOM) || text.trim() === '') {
    throw new ConverterFailure('invalid_input');
  }
  return text;
}
