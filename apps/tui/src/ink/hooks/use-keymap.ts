import {useInput, type Key} from 'ink';
import {useInputEnabled} from './input-scope';

/** Shared source for dispatch and help; feature inputs must disable themselves behind overlays. */
export const KEYMAP = [
  {action: 'close', keys: 'Esc', label: 'Close overlay / interrupt'},
  {action: 'submit', keys: 'Enter', label: 'Submit / select'},
  {action: 'newline', keys: 'Shift+Enter', label: 'New line'},
  {action: 'previous', keys: '↑', label: 'Previous item'},
  {action: 'next', keys: '↓', label: 'Next item'},
  {action: 'expand', keys: 'Ctrl+O', label: 'Expand / collapse output'},
  {action: 'history', keys: 'Ctrl+R', label: 'Search history'},
  {action: 'permissions', keys: 'Shift+Tab', label: 'Cycle permission preset'},
  {action: 'exit', keys: 'Ctrl+C', label: 'Exit'},
] as const;
export type KeyAction = (typeof KEYMAP)[number]['action'];
export type KeyHandlers = Partial<Record<KeyAction, () => void>>;
export function keyAction(input: string, key: Key): KeyAction | undefined {
  if (key.eventType === 'release') return;
  if (key.ctrl && !key.meta && !key.shift) {
    if (input === 'c') return 'exit';
    if (input === 'o') return 'expand';
    if (input === 'r') return 'history';
    return;
  }
  if (key.ctrl || key.meta || key.super || key.hyper) return;
  if (key.escape) return 'close';
  if (key.return) return key.shift ? 'newline' : 'submit';
  if (key.upArrow) return 'previous';
  if (key.downArrow) return 'next';
  if (key.tab && key.shift) return 'permissions';
  return;
}
export function useKeymap(handlers: KeyHandlers, options: {isActive?: boolean} = {}): void {
  const isActive = useInputEnabled(options.isActive);
  useInput(
    (input, key) => {
      const action = keyAction(input, key);
      if (action) handlers[action]?.();
    },
    {isActive: isActive},
  );
}
