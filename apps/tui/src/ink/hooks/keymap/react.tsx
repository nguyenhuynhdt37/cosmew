/** @jsxImportSource react */
import {createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode} from 'react';
import {useInput} from 'ink';
import {useInputEnabled} from '../input-scope';
import {KeyRouter, type ContextHandlers, type Registration} from './router';
import {keymapStore} from './store';
import type {KeyContext} from './defaults';
import {chordsFor} from './keymap';
import {displayChord, parseChord} from './keystroke';

const RouterContext = createContext<KeyRouter | null>(null);
/** One dispatcher for the whole app: nested features register contexts instead of each reading stdin. */
export function KeymapProvider({children}: {children: ReactNode}) {
  const router = useMemo(() => new KeyRouter({keymap: () => keymapStore.get()}), []);
  const isRawModeSupported = useInputEnabled();
  useInput((input, key) => void router.dispatch(input, key), {isActive: isRawModeSupported});
  return <RouterContext.Provider value={router}>{children}</RouterContext.Provider>;
}
/** The shared router, or null when rendered without a provider (isolated component tests). */
export function useKeyRouter(): KeyRouter | null {
  return useContext(RouterContext);
}
/** Chord typed so far (`ctrl+x`) while waiting for its second key; empty otherwise. */
export function useChordPending(): string {
  const router = useKeyRouter();
  return useSyncExternalStore(
    listener => router?.subscribe(listener) ?? (() => {}),
    () => router?.pending ?? '',
  );
}
export interface KeybindingOptions {
  isActive?: boolean;
  onKey?: Registration['onKey'];
  rawFirst?: boolean;
}
/**
 * Register handlers per context (`{Chat: {'chat:submit': fn}}`). Handlers return false to decline a key. Without a
 * provider the hook runs its own router, so a component can be rendered alone.
 */
export function useKeybindings(handlers: ContextHandlers, options: KeybindingOptions = {}): void {
  const shared = useContext(RouterContext);
  const local = useMemo(() => (shared ? null : new KeyRouter({keymap: () => keymapStore.get()})), [shared]);
  const router = shared ?? local!;
  const enabled = useInputEnabled(options.isActive);
  const latest = useRef<(Registration & {dispose(): void}) | null>(null);
  const state = {handlers, active: enabled, onKey: options.onKey, rawFirst: options.rawFirst};
  if (latest.current) Object.assign(latest.current, state);
  useEffect(() => {
    const registration = router.register(state);
    latest.current = registration;
    return () => {
      registration.dispose();
      latest.current = null;
    };
  }, [router]);
  useInput((input, key) => void local?.dispatch(input, key), {isActive: !!local && enabled});
}

/** Current user-remapped key label, shared by panel footers and dispatch. */
export function useBindingLabel(context: KeyContext, action: string): string {
  const map = useSyncExternalStore(
    listener => keymapStore.subscribe(listener),
    () => keymapStore.get(),
  );
  return (
    chordsFor(map, context, action)
      .map(chord => {
        const parsed = parseChord(chord);
        return parsed.ok ? displayChord(parsed.value) : chord;
      })
      .join('/') || 'unbound'
  );
}
