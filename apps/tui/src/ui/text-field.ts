export interface FieldOptions {
  /** Maximum stored length. */
  max: number;
  /** Characters outside this pattern are ignored (default: any single code unit). */
  accept?: RegExp;
}

/**
 * Apply a key to a single-line draft. Returns the new value when the key edits the
 * field (Backspace or one accepted character), or null when it is not an edit.
 */
export function editField(value: string, key: string, options: FieldOptions): string | null {
  if (key === 'Backspace') return value.slice(0, -1);
  if (key.length === 1 && (!options.accept || options.accept.test(key))) return (value + key).slice(0, options.max);
  return null;
}
