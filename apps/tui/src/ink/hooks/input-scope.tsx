/** @jsxImportSource react */
import {createContext, useContext, type ReactNode} from 'react';
import {useInput, useStdin, type Key} from 'ink';
const InputContext = createContext(true);
/** Shell disables background input without unmounting transcript/composer state. */
export function InputScope({active, children}: {active: boolean; children: ReactNode}) {
  const parent = useContext(InputContext);
  return <InputContext.Provider value={parent && active}>{children}</InputContext.Provider>;
}
export function useInputEnabled(isActive = true): boolean {
  const scoped = useContext(InputContext);
  const {isRawModeSupported} = useStdin();
  return scoped && isActive && isRawModeSupported;
}
/** Use for text entry; named shortcuts should go through useKeymap. */
export function useTextInput(handler: (input: string, key: Key) => void, options: {isActive?: boolean} = {}): void {
  const isActive = useInputEnabled(options.isActive);
  useInput(handler, {isActive});
}
