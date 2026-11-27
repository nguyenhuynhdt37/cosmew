/** @jsxImportSource react */
import {createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode} from 'react';
export interface OverlayEntry {
  id: string;
  content: ReactNode;
  fullScreen?: boolean;
}
export interface OverlayRouter {
  active: OverlayEntry | null;
  selections: Map<string, string>;
  tasks: Map<AbortController, Promise<unknown>>;
  open(id: string, content: ReactNode): void;
  push(id: string, content: ReactNode): void;
  replace(id: string, content: ReactNode): void;
  close(): void;
  setFullScreen(id: string, enabled: boolean): void;
}
const OverlayContext = createContext<OverlayRouter | null>(null);
export function OverlayProvider({children}: {children: ReactNode}) {
  const tasks = useRef(new Map<AbortController, Promise<unknown>>()).current;
  const selections = useRef(new Map<string, string>()).current;
  const [active, setActive] = useState<OverlayEntry | null>(null);
  const activeRef = useRef<OverlayEntry | null>(null);
  const stack = useRef<OverlayEntry[]>([]);
  const open = useCallback((id: string, content: ReactNode) => {
    stack.current = [];
    const next: OverlayEntry = {id, content};
    activeRef.current = next;
    setActive(next);
  }, []);
  const push = useCallback((id: string, content: ReactNode) => {
    if (activeRef.current) stack.current.push(activeRef.current);
    const next: OverlayEntry = {id, content};
    activeRef.current = next;
    setActive(next);
  }, []);
  const replace = useCallback((id: string, content: ReactNode) => {
    const next: OverlayEntry = {id, content};
    activeRef.current = next;
    setActive(next);
  }, []);
  const close = useCallback(() => {
    const next = stack.current.pop() ?? null;
    activeRef.current = next;
    setActive(next);
  }, []);
  const setFullScreen = useCallback((id: string, enabled: boolean) => {
    setActive(current => {
      const next = current?.id === id && !!current.fullScreen !== enabled ? {...current, fullScreen: enabled} : current;
      activeRef.current = next;
      return next;
    });
  }, []);
  const value = useMemo(
    () => ({active, open, push, replace, close, selections, tasks, setFullScreen}),
    [active, open, push, replace, close, selections, tasks, setFullScreen],
  );
  return <OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>;
}
export function useOverlay(): OverlayRouter {
  const router = useContext(OverlayContext);
  if (!router) throw new Error('useOverlay requires OverlayProvider');
  return router;
}
