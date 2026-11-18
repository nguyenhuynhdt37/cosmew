/** @jsxImportSource react */
import {createContext, useCallback, useContext, useMemo, useState, type ReactNode} from 'react';
export interface OverlayEntry {
  id: string;
  content: ReactNode;
}
export interface OverlayRouter {
  active: OverlayEntry | null;
  open(id: string, content: ReactNode): void;
  close(): void;
}
const OverlayContext = createContext<OverlayRouter | null>(null);
export function OverlayProvider({children}: {children: ReactNode}) {
  const [active, setActive] = useState<OverlayEntry | null>(null);
  const open = useCallback((id: string, content: ReactNode) => setActive({id, content}), []);
  const close = useCallback(() => setActive(null), []);
  const value = useMemo(() => ({active, open, close}), [active, open, close]);
  return <OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>;
}
export function useOverlay(): OverlayRouter {
  const router = useContext(OverlayContext);
  if (!router) throw new Error('useOverlay requires OverlayProvider');
  return router;
}
