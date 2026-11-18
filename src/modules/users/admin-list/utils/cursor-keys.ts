export const MIN_CURSOR_KEY_BYTES = 32;
const KID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export type CursorKeysResult =
  | { ok: true; activeKid: string; keys: ReadonlyMap<string, Buffer> }
  | { ok: false; reason: string };

/**
 * Parses `USER_LIST_CURSOR_ACTIVE_KEY_ID` and `USER_LIST_CURSOR_HMAC_KEYS`
 * (`kid:secret,kid2:secret2`). Valid only when every kid is well-formed and
 * unique, every secret has at least 32 bytes and the active kid is listed.
 */
export function parseCursorKeys(
  activeKid: unknown,
  rawKeys: unknown,
): CursorKeysResult {
  if (typeof activeKid !== 'string' || !KID_PATTERN.test(activeKid)) {
    return { ok: false, reason: 'Active cursor key id is missing or invalid' };
  }
  if (typeof rawKeys !== 'string' || rawKeys.trim() === '') {
    return { ok: false, reason: 'Cursor HMAC keys are missing' };
  }
  const keys = new Map<string, Buffer>();
  for (const entry of rawKeys.split(',')) {
    const separator = entry.indexOf(':');
    const kid = entry.slice(0, separator).trim();
    const secret = entry.slice(separator + 1).trim();
    if (separator < 0 || !KID_PATTERN.test(kid)) {
      return { ok: false, reason: 'Cursor HMAC keys are malformed' };
    }
    if (keys.has(kid)) {
      return { ok: false, reason: 'Cursor key ids must be unique' };
    }
    if (Buffer.byteLength(secret) < MIN_CURSOR_KEY_BYTES) {
      return {
        ok: false,
        reason: `Every cursor key must be at least ${MIN_CURSOR_KEY_BYTES} bytes`,
      };
    }
    keys.set(kid, Buffer.from(secret));
  }
  if (!keys.has(activeKid)) {
    return { ok: false, reason: 'Active cursor key id is not in the key list' };
  }
  return { ok: true, activeKid, keys };
}
