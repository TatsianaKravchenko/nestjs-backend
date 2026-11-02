/** Names and actions are compared and stored trimmed and lowercased. */
export const normalizeName = (value: string): string =>
  value.trim().toLowerCase();

/** Class-transformer hook: normalizes a string name, leaves other values to the validators. */
export const normalizeNameTransform = ({
  value,
}: {
  value: unknown;
}): unknown => (typeof value === 'string' ? normalizeName(value) : value);

/** Descriptions are trimmed; an empty string means "no description". */
export const normalizeDescription = (
  value: string | null | undefined,
): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

export const normalizeDescriptionTransform = ({
  value,
}: {
  value: unknown;
}): unknown =>
  typeof value === 'string' ? (normalizeDescription(value) ?? null) : value;
