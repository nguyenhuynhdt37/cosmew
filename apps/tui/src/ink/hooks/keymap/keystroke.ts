import type {Key} from 'ink';

/** One key press with its modifiers. `alt` also stands for Option and Meta; `super` for Cmd/Win. */
export interface Keystroke {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  super: boolean;
}
export type Chord = readonly Keystroke[];
export type ParseResult<T> = {ok: true; value: T} | {ok: false; error: string};

const MODIFIERS: Record<string, 'ctrl' | 'alt' | 'shift' | 'super'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  opt: 'alt',
  option: 'alt',
  meta: 'alt',
  shift: 'shift',
  cmd: 'super',
  command: 'super',
  super: 'super',
  win: 'super',
};
const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  escape: 'escape',
  enter: 'enter',
  return: 'enter',
  tab: 'tab',
  space: 'space',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  pageup: 'pageup',
  pagedown: 'pagedown',
  home: 'home',
  end: 'end',
  backspace: 'backspace',
  delete: 'delete',
  del: 'delete',
};
const DISPLAY: Record<string, string> = {
  escape: 'esc',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
};

/** `ctrl+k`, `Option+P`, `shift+tab`. A bare uppercase letter is just that letter (case-insensitive). */
export function parseKeystroke(text: string): ParseResult<Keystroke> {
  const original = text;
  const stroke: Keystroke = {key: '', ctrl: false, alt: false, shift: false, super: false};
  let rest = text.trim();
  if (!rest) return {ok: false, error: 'Empty key'};
  for (;;) {
    const match = /^([A-Za-z]+)\+(.*)$/s.exec(rest);
    if (!match) break;
    const modifier = MODIFIERS[match[1]!.toLowerCase()];
    // A single letter before `+` followed by more text can still be a typo (`ctrl+x+y`): report the unknown modifier.
    if (!modifier) return {ok: false, error: `Unknown modifier "${match[1]}" in "${original}"`};
    stroke[modifier] = true;
    rest = match[2]!;
  }
  if (!rest) return {ok: false, error: `Missing key after the modifier in "${original}"`};
  if (/\s/.test(rest)) return {ok: false, error: `Unexpected space in "${original}"`};
  const named = KEY_ALIASES[rest.toLowerCase()];
  if (named) stroke.key = named;
  else if ([...rest].length === 1) stroke.key = rest.toLowerCase();
  else return {ok: false, error: `Unknown key "${rest}" in "${original}"`};
  return {ok: true, value: stroke};
}
/** A chord is keystrokes separated by spaces (`ctrl+x ctrl+k`). A space inside `ctrl+ k` is reported, not guessed. */
export function parseChord(text: string): ParseResult<Chord> {
  const trimmed = text.trim();
  if (/\+\s/.test(trimmed))
    return {
      ok: false,
      error: `A space follows "+" in "${text}": write the modifier and key together, for example ctrl+k`,
    };
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (!parts.length) return {ok: false, error: 'Empty key'};
  const strokes: Keystroke[] = [];
  for (const part of parts) {
    const parsed = parseKeystroke(part);
    if (!parsed.ok) return parsed;
    strokes.push(parsed.value);
  }
  return {ok: true, value: strokes};
}
/** Canonical, case-folded text; two spellings of the same key format equally. */
export function formatKeystroke(stroke: Keystroke): string {
  return [stroke.ctrl && 'ctrl', stroke.alt && 'alt', stroke.shift && 'shift', stroke.super && 'cmd', stroke.key]
    .filter(Boolean)
    .join('+');
}
export function formatChord(chord: Chord): string {
  return chord.map(formatKeystroke).join(' ');
}
/** Display text for help: `ctrl+x ctrl+k`, `opt+p` on macOS style is left to the caller. */
export function displayKeystroke(stroke: Keystroke): string {
  const key = DISPLAY[stroke.key] ?? stroke.key;
  return [stroke.ctrl && 'ctrl', stroke.alt && 'alt', stroke.shift && 'shift', stroke.super && 'cmd', key]
    .filter(Boolean)
    .join('+');
}
export function displayChord(chord: Chord): string {
  return chord.map(displayKeystroke).join(' ');
}
export function sameKeystroke(a: Keystroke, b: Keystroke): boolean {
  return a.key === b.key && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.super === b.super;
}
/** Keys no binding may take: the terminal sends the same byte as another key (Ctrl+M = Enter ...) or the app needs them. */
export const RESERVED_KEYSTROKES: readonly string[] = ['ctrl+c', 'ctrl+d', 'ctrl+m', 'ctrl+[', 'ctrl+i', 'ctrl+h'];
export function isReserved(stroke: Keystroke): boolean {
  return RESERVED_KEYSTROKES.includes(formatKeystroke(stroke));
}
/** A key that types a character (no ctrl/alt/super): text fields consume it before any single-letter binding. */
export function isPrintable(stroke: Keystroke): boolean {
  return !stroke.ctrl && !stroke.alt && !stroke.super && (stroke.key === 'space' || [...stroke.key].length === 1);
}
/** Translate Ink's decoded key; undefined for releases and for multi-character (pasted) input. */
export function fromInk(input: string, key: Key): Keystroke | undefined {
  if (key.eventType === 'release') return undefined;
  const stroke: Keystroke = {key: '', ctrl: key.ctrl, alt: key.meta, shift: key.shift, super: key.super};
  if (key.upArrow) stroke.key = 'up';
  else if (key.downArrow) stroke.key = 'down';
  else if (key.leftArrow) stroke.key = 'left';
  else if (key.rightArrow) stroke.key = 'right';
  else if (key.pageUp) stroke.key = 'pageup';
  else if (key.pageDown) stroke.key = 'pagedown';
  else if (key.home) stroke.key = 'home';
  else if (key.end) stroke.key = 'end';
  else if (key.return) stroke.key = 'enter';
  else if (key.escape) stroke.key = 'escape';
  else if (key.tab) stroke.key = 'tab';
  else if (key.backspace) stroke.key = 'backspace';
  else if (key.delete) stroke.key = 'delete';
  else if (input === '\n' && !key.ctrl) {
    // Ink decodes the line feed (Ctrl+J) as plain text.
    stroke.ctrl = true;
    stroke.key = 'j';
  } else if (input === ' ') stroke.key = 'space';
  else if ([...input].length === 1) {
    const lower = input.toLowerCase();
    stroke.key = lower;
    if (lower !== input) stroke.shift = true;
  } else return undefined;
  return stroke;
}
