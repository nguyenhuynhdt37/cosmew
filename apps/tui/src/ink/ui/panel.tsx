/** @jsxImportSource react */
import {Box, Text, measureElement, type DOMElement} from 'ink';
import {
  Children,
  Fragment,
  cloneElement,
  isValidElement,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {useDialogRows} from './dialog-layout';
import {useTheme} from '../theme';
import {safeText} from './text-line';
import {Rule} from './rule';
import {useUiTheme} from './ui-theme';
export interface PanelProps {
  children: ReactNode;
  title?: string;
  width?: number;
  focused?: boolean;
  padding?: number;
  tone?: 'info' | 'accent';
  /** Panels open with `▔`; permission, question and startup dialogs with `─`. */
  ruleStyle?: 'panel' | 'dialog';
  /** Resolved colour for the rule and the title (e.g. the warning colour of the trust screen). */
  accent?: string;
}
export function Panel({
  children,
  title,
  width,
  focused = false,
  padding,
  tone = 'accent',
  ruleStyle = 'panel',
  accent,
}: PanelProps) {
  const {color} = useTheme();
  const ui = useUiTheme();
  const rows = useDialogRows();
  const controlsRef = useRef<DOMElement>(null);
  const [controlsHeight, setControlsHeight] = useState(0);
  useLayoutEffect(() => {
    if (rows && controlsRef.current) {
      const next = measureElement(controlsRef.current).height;
      setControlsHeight(previous => (previous === next ? previous : next));
    }
  });
  // Existing feature dialogs put their action widgets after their body. Flatten only
  // arrays/fragments, preserving each widget's state and keyboard handler ownership.
  const flatten = (nodes: ReactNode): ReactNode[] =>
    Children.toArray(nodes).flatMap(node =>
      isValidElement<{children?: ReactNode}>(node) && node.type === Fragment ? flatten(node.props.children) : [node],
    );
  // Flattened fragment children come from different parents: give each one its own key.
  const nodes = flatten(children).map((node, at) =>
    isValidElement(node) ? cloneElement(node, {key: `panel-${at}`}) : node,
  );
  const controlsAt = nodes.findIndex(
    node =>
      isValidElement(node) &&
      typeof node.type === 'function' &&
      ['ListPicker', 'TextEntry', 'Detail', 'OptionList'].includes(node.type.name),
  );
  const body = nodes.slice(0, controlsAt < 0 ? -1 : controlsAt);
  const controls = controlsAt < 0 ? nodes.slice(-1) : nodes.slice(controlsAt);
  return (
    <Box flexDirection="column" width={width} minWidth={0}>
      <Rule width={width} color={accent} glyph={ruleStyle === 'dialog' ? '─' : '▔'} />
      <Box flexDirection="column" paddingX={padding ?? (ruleStyle === 'dialog' ? 1 : 2)} minWidth={0}>
        {title ? (
          <Text bold color={accent ?? ui.color('rule') ?? color(focused ? tone : 'foreground')}>
            {safeText(title)}
          </Text>
        ) : null}
        {rows ? (
          <>
            <Box
              flexDirection="column"
              flexShrink={1}
              maxHeight={Math.max(0, rows - 1 - (title ? 1 : 0) - controlsHeight)}
              overflow="hidden"
            >
              <Box flexDirection="column" flexShrink={0}>
                {body}
              </Box>
            </Box>
            <Box ref={controlsRef} flexDirection="column" flexShrink={0}>
              {controls}
            </Box>
          </>
        ) : (
          children
        )}
      </Box>
    </Box>
  );
}
