/** @jsxImportSource react */
import {Box, type BoxProps} from 'ink';
import type {ReactNode} from 'react';
import {useMouseTarget} from '../hooks/use-terminal-wheel';

/** Measure the entire row, including wrapped labels and descriptions. Clicks only move focus. */
export function MouseRow({
  onHighlight,
  isActive = true,
  children,
  ...props
}: BoxProps & {
  onHighlight?: () => void;
  isActive?: boolean;
  children: ReactNode;
}) {
  const ref = useMouseTarget(event => {
    if (!('direction' in event)) onHighlight?.();
  }, isActive && !!onHighlight);
  return (
    <Box ref={ref} flexShrink={0} {...props}>
      {children}
    </Box>
  );
}
