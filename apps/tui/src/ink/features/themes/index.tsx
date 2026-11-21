/** @jsxImportSource react */
import {useEffect} from 'react';
import {Box, Text} from 'ink';
import {useTheme} from '../../theme';
import {useOverlay} from '../../core';
import {ListPicker, Panel, Rule, TextLine, useUiTheme} from '../../ui';
import {useDialogSize, useDialogTask, type DialogProps} from '../picker';
/** Sample change drawn under the list so every highlighted theme is judged on real diff colours. */
const SAMPLE: readonly {n: number; sign: ' ' | '-' | '+'; text: string}[] = [
  {n: 1, sign: ' ', text: ' function greet() {'},
  {n: 2, sign: '-', text: '  console.log("Hello, World!");'},
  {n: 2, sign: '+', text: '  console.log("Hello, Cosmew!");'},
  {n: 3, sign: ' ', text: ' }'},
];
export function ThemesDialog(props: DialogProps) {
  const {engine, color} = useTheme();
  const ui = useUiTheme();
  const router = useOverlay();
  const task = useDialogTask();
  const size = useDialogSize(props);
  useEffect(
    () => () => {
      // Esc, or any other way out, undoes the live preview.
      if (engine.isPreviewing()) engine.cancelPreview();
    },
    [engine],
  );
  const muted = color('foregroundMuted');
  const themes = engine.listThemes('all');
  return (
    <Panel width={size.width}>
      <Text bold color={ui.color('rule')}>
        Theme
      </Text>
      <Box height={1} />
      <TextLine bold>Choose the text style that looks best with your terminal</TextLine>
      <Box height={1} />
      <ListPicker
        items={themes.map(theme => ({
          id: theme.id,
          label: theme.name,
          current: theme.id === engine.getCommittedAppearance().theme,
        }))}
        showSearch={false}
        visibleRows={Math.min(size.visibleRows, themes.length)}
        initialCursor={Math.max(
          0,
          themes.findIndex(theme => theme.id === engine.getCommittedAppearance().theme),
        )}
        onHighlight={item => engine.previewTheme(item.id)}
        hint={false}
        onSelect={item =>
          void task.run(async signal => {
            await engine.setTheme(item.id);
            if (!signal.aborted) router.close();
          })
        }
      />
      <Box height={1} />
      <Rule glyph="╌" color={muted} width={Math.max(1, size.width - 4)} />
      {SAMPLE.map(row => {
        const bg = row.sign === '+' ? ui.color('diffAdded') : row.sign === '-' ? ui.color('diffRemoved') : undefined;
        return (
          <Text key={`${row.n}${row.sign}`}>
            <Text
              backgroundColor={bg}
              color={row.sign === ' ' ? undefined : color(row.sign === '+' ? 'success' : 'error')}
            >
              {` ${row.n} ${row.sign === ' ' ? ' ' : row.sign}`}
            </Text>
            <Text backgroundColor={bg}>{row.text}</Text>
          </Text>
        );
      })}
      <Rule glyph="╌" color={muted} width={Math.max(1, size.width - 4)} />
      <TextLine
        color={muted}
      >{` Syntax highlighting: ${engine.getCommittedAppearance().syntaxHighlighting ? 'on' : 'off'}`}</TextLine>
      {task.message ? <TextLine color={color('warning')}>{task.message}</TextLine> : null}
      <Box height={1} />
      <TextLine color={muted}>Enter to select · Esc to cancel</TextLine>
    </Panel>
  );
}
