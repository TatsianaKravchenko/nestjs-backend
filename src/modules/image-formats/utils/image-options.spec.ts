import type { HttpException } from '@nestjs/common';

import { parseImageOptions } from './image-options';

const statusOf = (run: () => unknown): number | undefined => {
  try {
    run();
  } catch (error) {
    return (error as HttpException).getStatus();
  }
  return undefined;
};

describe('parseImageOptions', () => {
  it('applies the jpeg defaults', () => {
    expect(parseImageOptions(undefined, 'png', 'jpeg')).toEqual({
      quality: 85,
      background: '#ffffff',
    });
    expect(parseImageOptions('{}', 'svg', 'jpeg')).toEqual({
      quality: 85,
      background: '#ffffff',
    });
  });

  it('sets nothing for a png target from a raster source', () => {
    expect(parseImageOptions(undefined, 'jpeg', 'png')).toEqual({});
    expect(parseImageOptions('{}', 'jpeg', 'png')).toEqual({});
  });

  it('accepts every option where it applies', () => {
    expect(
      parseImageOptions(
        '{"quality":1,"background":"#AbCdEf","width":4096,"height":1}',
        'svg',
        'jpeg',
      ),
    ).toEqual({ quality: 1, background: '#abcdef', width: 4096, height: 1 });
  });

  it('accepts width and height for an svg -> png', () => {
    expect(parseImageOptions('{"width":10}', 'svg', 'png')).toEqual({
      width: 10,
    });
  });

  it.each([
    ['not json', 'nope'],
    ['an empty string', ''],
    ['null', 'null'],
    ['an array', '[1]'],
    ['a string', '"x"'],
    ['a number', '5'],
    ['an unknown option', '{"quality":50,"sharpen":true}'],
    ['a prototype key', '{"__proto__":{"quality":5}}'],
    ['quality 0', '{"quality":0}'],
    ['quality 101', '{"quality":101}'],
    ['a fractional quality', '{"quality":80.5}'],
    ['a string quality', '{"quality":"80"}'],
    ['a null quality', '{"quality":null}'],
    ['a short colour', '{"background":"#fff"}'],
    ['a colour without #', '{"background":"ffffff"}'],
    ['a named colour', '{"background":"red"}'],
    ['an alpha colour', '{"background":"#ffffff80"}'],
    ['a numeric colour', '{"background":16777215}'],
    ['width 0', '{"width":0}'],
    ['height 4097', '{"height":4097}'],
    ['a fractional width', '{"width":1.5}'],
  ])('rejects %s with 400 (svg -> jpeg)', (_label, raw) => {
    expect(statusOf(() => parseImageOptions(raw, 'svg', 'jpeg'))).toBe(400);
  });

  it.each([
    ['quality for a png target', 'svg', 'png', '{"quality":50}'],
    ['background for a png target', 'jpeg', 'png', '{"background":"#ffffff"}'],
    ['width for a png source', 'png', 'jpeg', '{"width":10}'],
    ['height for a jpeg source', 'jpeg', 'png', '{"height":10}'],
  ])('rejects %s with 400', (_label, source, target, raw) => {
    expect(statusOf(() => parseImageOptions(raw, source, target))).toBe(400);
  });
});
