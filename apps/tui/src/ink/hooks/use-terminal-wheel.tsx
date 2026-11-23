/** @jsxImportSource react */
import {createContext, useContext, useEffect, useRef} from 'react';
import type {DOMElement} from 'ink';
import {useInputEnabled} from './input-scope';
import type {TerminalMouseEvent, TerminalMouseInput, TerminalWheel} from '../../input/mouse-input';

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

/** Hit test the current layout, including scrolled/clipped ancestors. Terminal coordinates are 1-based. */
export function mouseHits(element: DOMElement | null, event: TerminalMouseEvent): boolean {
  if (!element?.yogaNode) return false;
  const bounds = (node: DOMElement) => {
    let x = 0,
      y = 0;
    for (let current: DOMElement | undefined = node; current; current = current.parentNode) {
      if (current.isHidden || current.style.display === 'none') return undefined;
      x += current.yogaNode?.getComputedLeft() ?? 0;
      y += current.yogaNode?.getComputedTop() ?? 0;
      if (current !== node) {
        x -= current.style.contentOffsetX ?? 0;
        y -= current.style.contentOffsetY ?? 0;
      }
    }
    return {x, y, width: node.yogaNode?.getComputedWidth() ?? 0, height: node.yogaNode?.getComputedHeight() ?? 0};
  };
  const x = event.column - 1,
    y = event.row - 1;
  for (let node: DOMElement | undefined = element; node; node = node.parentNode) {
    if (
      node !== element &&
      node.style.overflow !== 'hidden' &&
      node.style.overflowX !== 'hidden' &&
      node.style.overflowY !== 'hidden'
    )
      continue;
    const box = bounds(node);
    if (!box || x < box.x || x >= box.x + box.width || y < box.y || y >= box.y + box.height) return false;
  }
  return true;
}

/** Scoped control input: no stdin reader, no global click capture, no transcript selection handling. */
export function useMouseTarget(handler: (event: TerminalMouseEvent) => void, isActive = true) {
  const source = useContext(MouseContext);
  const ref = useRef<DOMElement>(null);
  const enabled = useInputEnabled(isActive);
  const latest = useRef({handler, enabled});
  latest.current = {handler, enabled};
  useEffect(() => {
    const subscribe = source?.subscribeMouse?.bind(source) ?? source?.subscribe.bind(source);
    return subscribe?.(event => {
      if (latest.current.enabled && mouseHits(ref.current, event)) latest.current.handler(event);
    });
  }, [source]);
  return ref;
}

/** Native terminal selection owns the mouse while keyboard input remains with Ink. */
export function useTerminalMouseCapture(enabled: boolean): void {
  const source = useContext(MouseContext);
  useEffect(() => {
    source?.setCaptureEnabled?.(enabled);
    return () => source?.setCaptureEnabled?.(true);
  }, [source, enabled]);
}
