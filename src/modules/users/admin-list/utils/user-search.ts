import { invalidRequest } from '@/modules/auth/errors/auth.errors';

export const SEARCH_BY = ['id', 'email', 'displayName'] as const;
export type SearchBy = (typeof SEARCH_BY)[number];

export interface UserSearch {
  by: SearchBy;
  /** `id`: exact value. `email`/`displayName`: normalized literal prefix (unescaped). */
  value: string;
}

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
// Visible ASCII only: no space, no control characters.
const EMAIL_PATTERN = /^[\x21-\x7e]{3,254}$/;
// C0 controls, DEL and C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const DISPLAY_NAME_MIN = 3;
const DISPLAY_NAME_MAX = 80;

/** Escapes `\`, `%` and `_` so the value is matched literally by `LIKE ... ESCAPE '\'`. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

const bad = (field: string) => invalidRequest(`Invalid ${field}`);

/** Validates and normalizes `searchBy` + `q` (both present, checked by the caller). */
export function normalizeSearch(by: SearchBy, q: string): UserSearch {
  if (by === 'id') {
    if (!ID_PATTERN.test(q)) throw bad('q');
    return { by, value: q };
  }
  if (by === 'email') {
    const email = q.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) throw bad('q');
    return { by, value: email };
  }
  const name = q.trim().normalize('NFC');
  const length = Array.from(name).length;
  if (
    length < DISPLAY_NAME_MIN ||
    length > DISPLAY_NAME_MAX ||
    CONTROL_CHARS.test(name)
  ) {
    throw bad('q');
  }
  // Same expression as the SQL side: lower(normalize(display_name, NFC)).
  return { by, value: name.toLowerCase().normalize('NFC') };
}
