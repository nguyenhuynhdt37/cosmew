/** @jsxImportSource react */
import {createContext, useCallback, useContext, type ReactNode} from 'react';
import {Box, type DOMElement} from 'ink';
import {useMouseTarget} from '../../hooks/use-terminal-wheel';

export interface ActivityAnchor {
  itemId: string;
  node: DOMElement;
}
export const ActivityNavigation = createContext<{
  anchors: Map<string, ActivityAnchor>;
  toggle(itemId: string, id: string): void;
  expandHint: string;
} | null>(null);

/** Register the same measured row for mouse hit testing and keyboard reveal. Only the label is actionable. */
export function ActivityRow({
  itemId,
  id,
  width,
  children,
}: {
  itemId: string;
  id: string;
  width: number;
  children: ReactNode;
}) {
  const navigation = useContext(ActivityNavigation);
  const target = useMouseTarget(event => {
    if (!('direction' in event)) navigation?.toggle(itemId, id);
  }, !!navigation);
  const anchors = navigation?.anchors;
  const ref = useCallback(
    (node: DOMElement | null) => {
      target.current = node;
      if (node) anchors?.set(id, {itemId, node});
      else anchors?.delete(id);
    },
    [anchors, target, id, itemId],
  );
  return (
    <Box ref={ref} alignSelf="flex-start" maxWidth={width} minWidth={0} flexShrink={0}>
      {children}
    </Box>
  );
}
