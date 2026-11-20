const FORMAT_PATTERN = /^[a-z0-9][a-z0-9.+-]{0,31}$/;
const CONTENT_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const EXTENSION_PATTERN = /^[a-z0-9]{1,16}$/;

/** Lowercase, trimmed. The result may still be invalid: check `isFormat`. */
export const normalizeFormat = (value: string): string =>
  value.trim().toLowerCase();

/** A format name that is safe to store, log and use as a map key. */
export const isFormat = (value: string): boolean => FORMAT_PATTERN.test(value);

/** A bare `type/subtype` without parameters: safe for a response header. */
export const isContentType = (value: string): boolean =>
  CONTENT_TYPE_PATTERN.test(value);

export const isExtension = (value: string): boolean =>
  EXTENSION_PATTERN.test(value);

export const pairKey = (source: string, target: string): string =>
  `${source}>${target}`;
