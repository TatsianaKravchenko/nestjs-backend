import { parseCursorKeys } from './cursor-keys';

const K1 = 'a'.repeat(32);
const K2 = 'b'.repeat(40);

describe('parseCursorKeys', () => {
  it('parses a valid list with the active id included', () => {
    const result = parseCursorKeys('k1', `k1:${K1}, k2:${K2}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.activeKid).toBe('k1');
      expect([...result.keys.keys()]).toEqual(['k1', 'k2']);
    }
  });

  it('keeps colons inside the secret', () => {
    const secret = `${K1}:with:colons`;
    const result = parseCursorKeys('k1', `k1:${secret}`);
    expect(result.ok && result.keys.get('k1')?.toString()).toBe(secret);
  });

  it.each([
    ['missing active id', undefined, `k1:${K1}`],
    ['invalid active id', 'bad id', `k1:${K1}`],
    ['missing keys', 'k1', undefined],
    ['blank keys', 'k1', '  '],
    ['entry without a colon', 'k1', 'k1'],
    ['bad kid', 'k1', `k 1:${K1}`],
    ['duplicate kid', 'k1', `k1:${K1},k1:${K2}`],
    ['short secret', 'k1', 'k1:short'],
    ['active id not listed', 'k9', `k1:${K1}`],
  ])('rejects %s', (_label, kid, keys) => {
    expect(parseCursorKeys(kid, keys).ok).toBe(false);
  });
});
