import {sanitizePaste} from '../input/terminal-keys';
import {previousGrapheme} from '../input/text';

export interface FieldOptions {
  /** Maximum stored length. */
  max: number;
  /** Characters outside this pattern are ignored. */
  accept?: RegExp;
}

/** Edit a single-line draft; pasted control bytes are data, never keyboard actions. */
export function editField(value: string, key: string, options: FieldOptions): string | null {
  if (key === 'Backspace') return value.slice(0, previousGrapheme(value, value.length));
  const text = key.startsWith('Paste:')
    ? sanitizePaste(key.slice(6)).replace(/\n/g, '')
    : [...key].length === 1 && !/[\x00-\x1f\x7f-\x9f]/.test(key)
      ? key
      : null;
  if (text === null) return null;
  const accepted = [...text]
    .filter(character => {
      if (!options.accept) return true;
      options.accept.lastIndex = 0;
      return options.accept.test(character);
    })
    .join('');
  return (value + accepted).slice(0, options.max);
}
