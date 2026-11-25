/**
 * What a stored file is, by its target format. The type of a download comes
 * from this table (the target format is validated on write), never from the
 * stored object or the client.
 */
const FILE_TYPES: Readonly<
  Record<string, { contentType: string; extension: string }>
> = {
  csv: { contentType: 'text/csv', extension: 'csv' },
  json: { contentType: 'application/json', extension: 'json' },
  xml: { contentType: 'application/xml', extension: 'xml' },
  yaml: { contentType: 'application/yaml', extension: 'yaml' },
  png: { contentType: 'image/png', extension: 'png' },
  jpeg: { contentType: 'image/jpeg', extension: 'jpeg' },
};

const FALLBACK = {
  contentType: 'application/octet-stream',
  extension: 'bin',
} as const;

export const storedFileType = (
  targetFormat: string,
): { contentType: string; extension: string } =>
  Object.prototype.hasOwnProperty.call(FILE_TYPES, targetFormat)
    ? FILE_TYPES[targetFormat]
    : FALLBACK;
