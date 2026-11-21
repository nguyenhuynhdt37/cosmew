import type {Key} from 'ink';
import {CONTEXT_RANK, type KeyContext} from './defaults';
import {hasPrefix, lookup, type Keymap} from './keymap';
import {displayChord, formatChord, fromInk, isPrintable, type Chord, type Keystroke} from './keystroke';

/** Return `false` to decline: the key then falls through to the next context. */
export type ActionHandler = (stroke: Keystroke) => boolean | void;
export type ContextHandlers = Partial<Record<KeyContext, Readonly<Record<string, ActionHandler>>>>;
export interface Registration {
  /** Evaluated at dispatch time: a background component behind a dialog is inactive. */
  active: boolean;
  handlers: ContextHandlers;
  /**
   * Raw keys no binding wants (typing, unbound editing keys). Return true when consumed. By default it runs after every
   * binding; with `rawFirst` it runs before this registration's own bindings (a text field owning printable keys).
   */
  onKey?: (input: string, key: Key, stroke: Keystroke | undefined) => boolean | void;
  rawFirst?: boolean;
  order: number;
}
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    (handle as {unref?: () => void}).unref?.();
    return handle;
  },
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
export const CHORD_TIMEOUT_MS = 3000;
export interface KeyRouterOptions {
  keymap: () => Keymap;
  clock?: Clock;
  chordTimeoutMs?: number;
  /** Short transient message ("Chord cancelled"). */
  onNotice?: (message: string) => void;
  /** `command:<name>` bindings. Returns false when the host cannot run commands right now. */
  onCommand?: (name: string) => boolean | void;
}
interface Entry {
  registration: Registration;
  context: KeyContext;
}
/**
 * Single dispatcher: finds the registered contexts, tries the innermost first, then outer ones and Global, resolves
 * chords with a timeout, and hands unbound keys to raw handlers. Pure of React so it can be tested with a fake clock.
 */
export class KeyRouter {
  private registrations = new Set<Registration>();
  private pendingChord: Keystroke[] = [];
  private timer: unknown;
  private listeners = new Set<() => void>();
  private sequence = 0;
  constructor(private options: KeyRouterOptions) {}
  configure(options: Partial<KeyRouterOptions>): void {
    this.options = {...this.options, ...options};
  }
  register(init: Omit<Registration, 'order'>): Registration & {dispose(): void} {
    const registration = Object.assign(init as Registration, {order: ++this.sequence, dispose: () => {}});
    this.registrations.add(registration);
    registration.dispose = () => this.registrations.delete(registration);
    return registration;
  }
  /** Chord typed so far, as help text (`ctrl+x`), or empty. */
  get pending(): string {
    return this.pendingChord.length ? displayChord(this.pendingChord) : '';
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify() {
    for (const listener of this.listeners) listener();
  }
  private clock(): Clock {
    return this.options.clock ?? systemClock;
  }
  private cancelPending(message?: string) {
    if (this.timer !== undefined) this.clock().clearTimeout(this.timer);
    this.timer = undefined;
    const had = this.pendingChord.length > 0;
    this.pendingChord = [];
    if (had) {
      this.notify();
      if (message) this.options.onNotice?.(message);
    }
  }
  private startPending(chord: Chord) {
    if (this.timer !== undefined) this.clock().clearTimeout(this.timer);
    this.pendingChord = [...chord];
    this.timer = this.clock().setTimeout(() => {
      this.timer = undefined;
      this.cancelPending('Chord cancelled');
    }, this.options.chordTimeoutMs ?? CHORD_TIMEOUT_MS);
    this.notify();
  }
  private entries(): Entry[] {
    const list: Entry[] = [];
    for (const registration of this.registrations) {
      if (!registration.active) continue;
      for (const context of Object.keys(registration.handlers) as KeyContext[]) {
        if (registration.handlers[context]) list.push({registration, context});
      }
    }
    // Innermost context first; among equals the most recently registered component wins.
    return list.sort(
      (a, b) => CONTEXT_RANK[b.context] - CONTEXT_RANK[a.context] || b.registration.order - a.registration.order,
    );
  }
  private raws(): Registration[] {
    return [...this.registrations].filter(r => r.active && r.onKey).sort((a, b) => b.order - a.order);
  }
  private runExact(entries: readonly Entry[], chord: Chord, stroke: Keystroke): boolean {
    const keymap = this.options.keymap();
    for (const {registration, context} of entries) {
      const action = lookup(keymap, context, chord);
      if (!action) continue;
      const handler = registration.handlers[context]?.[action];
      if (handler) {
        if (handler(stroke) !== false) return true;
      } else if (action.startsWith('command:') && this.options.onCommand) {
        const name = action.slice('command:'.length).trim().replace(/^\//, '');
        if (name && this.options.onCommand(name) !== false) return true;
      }
    }
    return false;
  }
  /** True when the key was consumed (a binding ran, a chord started or was cancelled, or a raw handler took it). */
  dispatch(input: string, key: Key): boolean {
    if (key.eventType === 'release') return false;
    const stroke = fromInk(input, key);
    const entries = this.entries();
    if (!stroke) {
      for (const registration of this.raws()) if (registration.onKey?.(input, key, undefined)) return true;
      return false;
    }
    const keymap = this.options.keymap();
    if (this.pendingChord.length) {
      const chord = [...this.pendingChord, stroke];
      if (this.runExact(entries, chord, stroke)) {
        this.cancelPending();
        return true;
      }
      if (entries.some(entry => this.startsChord(keymap, entry, chord))) {
        this.startPending(chord);
        return true;
      }
      this.cancelPending(stroke.key === 'escape' && !stroke.ctrl && !stroke.alt ? undefined : 'Chord cancelled');
      return true;
    }
    const first = new Set<Registration>();
    for (const entry of entries) {
      const {registration} = entry;
      if (registration.rawFirst && registration.onKey && !first.has(registration)) {
        first.add(registration);
        // A text field takes printable keys before any single-letter binding of an outer context.
        if (isPrintable(stroke) && registration.onKey(input, key, stroke)) return true;
      }
      if (this.runExact([entry], [stroke], stroke)) return true;
    }
    if (entries.some(entry => this.startsChord(keymap, entry, [stroke]))) {
      this.startPending([stroke]);
      return true;
    }
    for (const registration of this.raws())
      if (!registration.rawFirst && registration.onKey?.(input, key, stroke)) return true;
    return false;
  }
  /** A prefix only counts when this registration handles at least one chord that starts with it. */
  private startsChord(keymap: Keymap, entry: Entry, chord: Chord): boolean {
    if (!hasPrefix(keymap, entry.context, chord)) return false;
    const head = `${formatChord(chord)} `;
    for (const [text, action] of keymap.bindings.get(entry.context) ?? [])
      if (text.startsWith(head) && entry.registration.handlers[entry.context]?.[action]) return true;
    return false;
  }
  /** Drop a half-typed chord (the shell calls this when a dialog opens). */
  reset(): void {
    this.cancelPending();
  }
}
