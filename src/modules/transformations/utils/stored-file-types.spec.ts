import { storedFileType } from './stored-file-types';

describe('storedFileType', () => {
  it.each([
    ['csv', 'text/csv', 'csv'],
    ['json', 'application/json', 'json'],
    ['xml', 'application/xml', 'xml'],
    ['yaml', 'application/yaml', 'yaml'],
    ['png', 'image/png', 'png'],
    ['jpeg', 'image/jpeg', 'jpeg'],
  ])('maps %s', (format, contentType, extension) => {
    expect(storedFileType(format)).toEqual({ contentType, extension });
  });

  it('falls back to a binary download for an unknown format', () => {
    const fallback = {
      contentType: 'application/octet-stream',
      extension: 'bin',
    };
    expect(storedFileType('exe')).toEqual(fallback);
    expect(storedFileType('constructor')).toEqual(fallback);
  });
});
