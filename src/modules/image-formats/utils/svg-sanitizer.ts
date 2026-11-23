import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { ConverterFailure } from '@/modules/transformations/services/converter';

/** Elements that run code, embed foreign documents or load other resources. */
const FORBIDDEN_ELEMENTS = new Set([
  'script',
  'foreignobject',
  'iframe',
  'embed',
  'object',
  'applet',
  'handler',
  'listener',
]);

const MAX_ELEMENTS = 100_000;
const MAX_DEPTH = 256;

/** Doctype and entity declarations (XXE, entity expansion) and any other DTD part. */
const DTD = /<!\s*(doctype|entity|element|attlist|notation)/i;
/** Processing instructions other than the XML declaration (`xml-stylesheet`). */
const PROCESSING_INSTRUCTION = /<\?(?!xml\s)/i;
const ACTIVE_CONTENT = /<\s*(script|foreignobject)\b/i;
const SCRIPT_SCHEME = /(javascript|vbscript)\s*:|data\s*:\s*text\/html/i;
const CSS_IMPORT = /@import|image-set\s*\(|\bimage\s*\(/i;
const CSS_URL = /url\s*\(\s*(['"]?)([^)]*?)\1\s*\)/gi;
/** The only embedded data a reference may carry (no nested SVG, no HTML). */
const SAFE_DATA_URI =
  /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]*$/i;

const localName = (name: string): string =>
  name.slice(name.lastIndexOf(':') + 1).toLowerCase();

const fail = (): never => {
  throw new ConverterFailure('invalid_input');
};

/** A reference is fine when it points inside the document or is a safe data URI. */
const isLocalReference = (value: string): boolean => {
  const target = value.trim();
  return target.startsWith('#') || SAFE_DATA_URI.test(target);
};

/** Every `url(...)` in a value or style sheet must stay inside the document. */
function checkCss(value: string): void {
  if (CSS_IMPORT.test(value)) fail();
  for (const match of value.matchAll(CSS_URL)) {
    if (!isLocalReference(match[2])) fail();
  }
  // `url(` that the pattern could not read (unbalanced, escaped): not trusted.
  if (/url\s*\(/i.test(value.replace(CSS_URL, ''))) fail();
}

function checkAttribute(rawName: string, value: unknown): void {
  const name = localName(rawName);
  if (rawName.toLowerCase().startsWith('xmlns')) return;
  if (name.startsWith('on')) fail();
  if (name === 'base' && rawName.toLowerCase().startsWith('xml:')) fail();
  const text = typeof value === 'string' ? value : String(value);
  if (SCRIPT_SCHEME.test(text)) fail();
  if (name === 'href' || name === 'src') {
    if (!isLocalReference(text)) fail();
    return;
  }
  checkCss(text);
}

type XmlNode = Record<string, unknown>;

export interface SanitizedSvg {
  /** The validated document, as text. */
  text: string;
  /** The root declares a `viewBox`, `width` or `height`. */
  hasIntrinsicSize: boolean;
}

/**
 * Validates an SVG before it reaches the renderer. Anything that could run
 * code or reach for another resource is rejected, not repaired: DTDs and
 * entities, `<script>`, `<foreignObject>`, event handlers, `javascript:` URLs,
 * processing instructions, and every reference that leaves the document (an
 * `href`, `url(...)` or `@import` that is not `#id` or an embedded raster).
 * The renderer itself has no network or file access; this is a second layer.
 *
 * Failures are `invalid_input`; nothing about the content is reported.
 */
export function sanitizeSvg(data: Buffer): SanitizedSvg {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return fail();
  }
  if (
    DTD.test(text) ||
    PROCESSING_INSTRUCTION.test(text) ||
    ACTIVE_CONTENT.test(text)
  ) {
    fail();
  }
  if (XMLValidator.validate(text) !== true) fail();

  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '',
    processEntities: false,
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: false,
  });
  let tree: XmlNode[];
  try {
    tree = parser.parse(text) as XmlNode[];
  } catch {
    return fail();
  }

  let hasIntrinsicSize = false;
  let elements = 0;
  let roots = 0;
  const stack: { nodes: XmlNode[]; depth: number }[] = [
    { nodes: tree, depth: 1 },
  ];
  while (stack.length > 0) {
    const { nodes, depth } = stack.pop() as (typeof stack)[number];
    if (depth > MAX_DEPTH) fail();
    for (const node of nodes) {
      for (const key of Object.keys(node)) {
        if (key === ':@' || key.startsWith('?')) continue;
        if (key === '#text') {
          continue;
        }
        const name = localName(key);
        if (++elements > MAX_ELEMENTS || FORBIDDEN_ELEMENTS.has(name)) fail();
        const attributes = (node[':@'] ?? {}) as Record<string, unknown>;
        for (const [attribute, value] of Object.entries(attributes)) {
          checkAttribute(attribute, value);
        }
        const children = node[key] as XmlNode[];
        if (depth === 1) {
          roots++;
          if (name !== 'svg') fail();
          hasIntrinsicSize = ['viewbox', 'width', 'height'].some((wanted) =>
            Object.keys(attributes).some(
              (attribute) => attribute.toLowerCase() === wanted,
            ),
          );
        }
        if (name === 'style') {
          for (const child of children) {
            if (typeof child['#text'] === 'string') checkCss(child['#text']);
          }
        }
        stack.push({ nodes: children, depth: depth + 1 });
      }
    }
  }
  if (roots !== 1) fail();
  return { text, hasIntrinsicSize };
}
