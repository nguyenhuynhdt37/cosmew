/** @jsxImportSource react */
import {Box} from 'ink';
import {useState} from 'react';
import {useKeymap} from '../hooks';
import {KeyHint} from './key-hint';
import {safeText, TextLine} from './text-line';
export interface TruncateProps {
  text: string;
  maxLines?: number;
  expanded?: boolean;
  onToggle?: () => void;
  isActive?: boolean;
  width?: number;
}
export function Truncate({text, maxLines = 8, expanded, onToggle, isActive = false, width}: TruncateProps) {
  const [localExpanded, setExpanded] = useState(false);
  const open = expanded ?? localExpanded;
  const lines = safeText(text).split('\n');
  const limit = Math.max(1, maxLines);
  useKeymap(
    {
      expand: () => {
        if (expanded === undefined) setExpanded(value => !value);
        onToggle?.();
      },
    },
    {isActive},
  );
  return (
    <Box flexDirection="column" minWidth={0}>
      <TextLine width={width}>{(open ? lines : lines.slice(0, limit)).join('\n')}</TextLine>
      {lines.length > limit ? (
        <KeyHint keys="Ctrl+O" label={open ? 'collapse' : `expand · +${lines.length - limit} lines`} />
      ) : null}
    </Box>
  );
}
