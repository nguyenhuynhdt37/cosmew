import {defaultKeymap, type Keymap} from './keymap';

/** Process-wide effective keymap; hot reload swaps it and every router reads it at dispatch time. */
export class KeymapStore {
  private current: Keymap = defaultKeymap();
  private listeners = new Set<() => void>();
  get(): Keymap {
    return this.current;
  }
  set(keymap: Keymap): void {
    this.current = keymap;
    for (const listener of this.listeners) listener();
  }
  reset(): void {
    this.set(defaultKeymap());
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
export const keymapStore = new KeymapStore();
