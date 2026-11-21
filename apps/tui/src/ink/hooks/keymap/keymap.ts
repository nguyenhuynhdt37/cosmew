import {DEFAULT_BINDINGS, KEY_CONTEXTS, actionsOf, isKeyContext, type KeyContext} from './defaults';
import {displayChord, formatChord, isReserved, parseChord, type Chord} from './keystroke';

/** Effective bindings: defaults overlaid with the validated user file. */
export interface Keymap {
  /** context -> canonical chord text -> action id */
  bindings: ReadonlyMap<KeyContext, ReadonlyMap<string, string>>;
  /** context -> canonical chord prefixes (strictly shorter than a bound chord) */
  prefixes: ReadonlyMap<KeyContext, ReadonlySet<string>>;
  /** Validation problems of the user file; defaults stay in effect for everything that failed. */
  warnings: readonly string[];
}
export interface UserBindingBlock {
  context?: unknown;
  bindings?: unknown;
}
const COMMAND_PREFIX = 'command:';

function emptyMaps() {
  return {
    bindings: new Map<KeyContext, Map<string, string>>(KEY_CONTEXTS.map(context => [context, new Map()])),
    prefixes: new Map<KeyContext, Set<string>>(KEY_CONTEXTS.map(context => [context, new Set()])),
  };
}
function rebuildPrefixes(maps: ReturnType<typeof emptyMaps>) {
  for (const [context, table] of maps.bindings) {
    const prefixes = maps.prefixes.get(context)!;
    prefixes.clear();
    for (const text of table.keys()) {
      const parts = text.split(' ');
      for (let n = 1; n < parts.length; n++) prefixes.add(parts.slice(0, n).join(' '));
    }
  }
}
export function defaultKeymap(): Keymap {
  const maps = emptyMaps();
  for (const entry of DEFAULT_BINDINGS)
    for (const keys of entry.keys) {
      const chord = parseChord(keys);
      if (chord.ok) maps.bindings.get(entry.context)!.set(formatChord(chord.value), entry.action);
    }
  rebuildPrefixes(maps);
  return {...maps, warnings: []};
}
/**
 * Overlay the text of `~/.cosmew/keybindings.json`. Anything invalid is dropped with a warning and the default for that
 * key stays; the rest of the file still applies. Never throws.
 */
export function buildKeymap(userText?: string): Keymap {
  const base = defaultKeymap();
  if (userText === undefined) return base;
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(userText);
  } catch (error) {
    return {...base, warnings: [`keybindings.json is not valid JSON (${(error as Error).message}); defaults kept.`]};
  }
  const blocks = (parsed as {bindings?: unknown} | null)?.bindings;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(blocks))
    return {...base, warnings: ['keybindings.json needs {"bindings": [...]}; defaults kept.']};
  const maps = emptyMaps();
  for (const [context, table] of base.bindings)
    for (const [chord, action] of table) maps.bindings.get(context)!.set(chord, action);
  const seen = new Map<string, string>();
  for (const [at, raw] of (blocks as UserBindingBlock[]).entries()) {
    const label = `bindings[${at}]`;
    if (!raw || typeof raw !== 'object' || typeof raw.context !== 'string') {
      warnings.push(`${label}: "context" must be a string.`);
      continue;
    }
    if (!isKeyContext(raw.context)) {
      warnings.push(`${label}: unknown context "${raw.context}" (known: ${KEY_CONTEXTS.join(', ')}).`);
      continue;
    }
    if (!raw.bindings || typeof raw.bindings !== 'object' || Array.isArray(raw.bindings)) {
      warnings.push(`${label}: "bindings" must be an object of key -> action.`);
      continue;
    }
    const context = raw.context;
    for (const [keys, action] of Object.entries(raw.bindings as Record<string, unknown>)) {
      const chord = parseChord(keys);
      if (!chord.ok) {
        warnings.push(`${context}: ${chord.error}`);
        continue;
      }
      if (chord.value.length === 1 && isReserved(chord.value[0]!)) {
        warnings.push(`${context}: "${keys}" is reserved and cannot be rebound.`);
        continue;
      }
      if (action !== null && typeof action !== 'string') {
        warnings.push(`${context}: the action of "${keys}" must be a string or null.`);
        continue;
      }
      if (typeof action === 'string' && !actionsOf(context).has(action) && !action.startsWith(COMMAND_PREFIX)) {
        warnings.push(`${context}: unknown action "${action}" for "${keys}".`);
        continue;
      }
      if (action === COMMAND_PREFIX || action === `${COMMAND_PREFIX}/`) {
        warnings.push(`${context}: "${keys}" needs a command name after "command:".`);
        continue;
      }
      const canonical = formatChord(chord.value);
      const slot = `${context}\0${canonical}`;
      if (seen.has(slot)) warnings.push(`${context}: "${keys}" is bound more than once (the later entry wins).`);
      seen.set(slot, keys);
      if (action === null) maps.bindings.get(context)!.delete(canonical);
      else maps.bindings.get(context)!.set(canonical, action);
    }
  }
  rebuildPrefixes(maps);
  return {...maps, warnings};
}
export function lookup(keymap: Keymap, context: KeyContext, chord: Chord): string | undefined {
  return keymap.bindings.get(context)?.get(formatChord(chord));
}
export function hasPrefix(keymap: Keymap, context: KeyContext, chord: Chord): boolean {
  return keymap.prefixes.get(context)?.has(formatChord(chord)) ?? false;
}
/** Chords bound to an action in a context, in table order. */
export function chordsFor(keymap: Keymap, context: KeyContext, action: string): string[] {
  const found: string[] = [];
  for (const [text, bound] of keymap.bindings.get(context) ?? []) if (bound === action) found.push(text);
  return found;
}
/** First chord of an action as help text (`ctrl+x ctrl+k`, `opt+p`), or undefined when unbound. */
export function keyLabel(keymap: Keymap, context: KeyContext, action: string): string | undefined {
  const first = chordsFor(keymap, context, action)[0];
  if (!first) return undefined;
  const chord = parseChord(first);
  return chord.ok ? displayChord(chord.value) : first;
}
/** Every chord of an action as help text. */
export function keyLabels(keymap: Keymap, context: KeyContext, action: string): string[] {
  return chordsFor(keymap, context, action).map(text => {
    const chord = parseChord(text);
    return chord.ok ? displayChord(chord.value) : text;
  });
}
