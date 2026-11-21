/** @jsxImportSource react */
import {useSyncExternalStore} from 'react';
import {Box, Text} from 'ink';
import {keyLabels, keymapStore} from '../../hooks';
import {Rule, stringCells} from '../../ui';
import {useUiTheme} from '../../ui/ui-theme';
import {composeDetailedFooter, type DetailedFooterInput} from './footer-logic';

type DetailedFooterProps = Omit<DetailedFooterInput, 'toggleKey'> & {toggleKey?: string};

/** The composer replacement in detailed mode; all hints use the live central keymap. */
export function DetailedFooter(props: DetailedFooterProps) {
  const ui = useUiTheme();
  const keymap = useSyncExternalStore(
    listener => keymapStore.subscribe(listener),
    () => keymapStore.get(),
  );
  const key = (context: 'Global' | 'Transcript', action: string) => keyLabels(keymap, context, action)[0] ?? 'unbound';
  const scrollKey = (action: string, arrow: string) => {
    const labels = keyLabels(keymap, 'Transcript', action);
    return labels.find(label => label === arrow) ?? labels[0] ?? 'unbound';
  };
  const {left, right} = composeDetailedFooter({
    toggleKey: key('Global', 'app:toggleTranscript'),
    showAllKey: key('Transcript', 'transcript:toggleShowAll'),
    editorKey: key('Transcript', 'transcript:openEditor'),
    helpKey: key('Transcript', 'transcript:help'),
    nextMatchKey: key('Transcript', 'transcript:nextMatch'),
    previousMatchKey: key('Transcript', 'transcript:previousMatch').replace(/^shift\+([a-z])$/, (_, letter: string) =>
      letter.toUpperCase(),
    ),
    scrollKeys: `${scrollKey('scroll:lineUp', '↑')}/${scrollKey('scroll:lineDown', '↓')}`,
    ...props,
  });
  return (
    <Box flexDirection="column" width={props.width} flexShrink={0}>
      <Rule width={props.width} />
      <Box width={props.width} paddingLeft={Math.min(2, props.width)}>
        <Text color={ui.color('dim')} wrap="truncate-end">
          {props.status && left.startsWith(props.status) ? (
            <>
              <Text color={ui.color(props.status === 'dialog waiting' ? 'selected' : 'accent')}>{props.status}</Text>
              {left.slice(props.status.length)}
            </>
          ) : (
            left
          )}
          {' '.repeat(Math.max(0, props.width - 2 - stringCells(left) - stringCells(right)))}
          {right}
        </Text>
      </Box>
    </Box>
  );
}
