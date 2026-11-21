/** @jsxImportSource react */
import {createContext, useContext, useEffect, useRef} from 'react';
import type {TerminalMouseInput, TerminalWheel} from '../../input/mouse-input';

const MouseContext = createContext<TerminalMouseInput | null>(null);
export const TerminalMouseProvider = MouseContext.Provider;

export function useTerminalWheel(handler: (event: TerminalWheel) => void, isActive: boolean): void {
  const source = useContext(MouseContext);
  const latest = useRef({handler, isActive});
  latest.current = {handler, isActive};
  useEffect(
    () =>
      source?.subscribe(event => {
        if (latest.current.isActive) latest.current.handler(event);
      }),
    [source],
  );
}
