/** @jsxImportSource react */
import {useSyncExternalStore} from 'react';
import {Box, Text} from 'ink';
import {keymapStore, transcriptLegend} from '../../hooks/keymap';
import {Rule, stringCells} from '../../ui';

export function TranscriptLegend({width, editorName}: {width: number; editorName?: string}) {
  const keymap = useSyncExternalStore(
    listener => keymapStore.subscribe(listener),
    () => keymapStore.get(),
  );
  const lines = transcriptLegend(keymap, editorName);
  // B3: column-major, four/four/three rows at 100; a single column at 40.
  const columns = [lines.slice(0, 4), lines.slice(4, 8), lines.slice(8)];
  const sizes = columns.map(column => Math.max(...column.map(stringCells)) + 4);
  const wide = sizes.reduce((sum, size) => sum + size, 2) <= width;
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Rule width={width} />
      <Box paddingLeft={2} width={width}>
        {(wide ? columns : [lines]).map((column, at) => (
          <Box key={at} flexDirection="column" width={wide ? sizes[at] : Math.max(1, width - 2)}>
            {column.map(line => (
              <Text key={line} dimColor wrap="truncate-end">
                {line}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
