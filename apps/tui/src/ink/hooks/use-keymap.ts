import {useKeybindings, type ContextHandlers} from './keymap';
import type {Keystroke} from './keymap';

/**
 * Legacy vocabulary of simple dialogs (navigate, choose, close), mapped onto the central keymap: a handler runs for the
 * keys the Select/Chat/Global contexts bind to the matching action, including user remaps. Letter keys (j/k) are not
 * routed here because many of these dialogs share the screen with a text field; `ListPicker` opts in explicitly.
 */
export type KeyAction =
  'close' | 'submit' | 'newline' | 'previous' | 'next' | 'expand' | 'history' | 'permissions' | 'exit';
export type KeyHandlers = Partial<Record<KeyAction, () => void>>;
const arrowsOnly = (fn: () => void) => (stroke: Keystroke) => {
  if (stroke.key === 'j' || stroke.key === 'k') return false;
  fn();
};
const plain = (fn: () => void) => () => {
  fn();
};
export function useKeymap(handlers: KeyHandlers, options: {isActive?: boolean} = {}): void {
  const map: ContextHandlers = {};
  const select: Record<string, (stroke: Keystroke) => boolean | void> = {};
  if (handlers.previous) select['select:previous'] = arrowsOnly(handlers.previous);
  if (handlers.next) select['select:next'] = arrowsOnly(handlers.next);
  if (handlers.submit) select['select:accept'] = plain(handlers.submit);
  if (handlers.close) select['select:cancel'] = plain(handlers.close);
  if (Object.keys(select).length) map.Select = select;
  const global: Record<string, (stroke: Keystroke) => boolean | void> = {};
  if (handlers.expand) global['app:toggleTranscript'] = plain(handlers.expand);
  if (handlers.history) global['history:search'] = plain(handlers.history);
  if (handlers.exit) global['app:interrupt'] = plain(handlers.exit);
  if (Object.keys(global).length) map.Global = global;
  const chat: Record<string, (stroke: Keystroke) => boolean | void> = {};
  if (handlers.permissions) chat['chat:cycleMode'] = plain(handlers.permissions);
  if (handlers.newline) chat['chat:newline'] = plain(handlers.newline);
  if (Object.keys(chat).length) map.Chat = chat;
  useKeybindings(map, {isActive: options.isActive});
}
