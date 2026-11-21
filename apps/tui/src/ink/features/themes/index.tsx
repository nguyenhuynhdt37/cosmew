/** @jsxImportSource react */
import {useEffect} from 'react';
import {Box, Text} from 'ink';
import {useFutrynClient} from '../../hooks';
import {useTheme} from '../../theme';
import {useOverlay} from '../../core';
import {DiffView, ListPicker, Panel, Rule, TextLine, useUiTheme} from '../../ui';
import {useDialogSize, useDialogTask, type DialogProps} from '../picker';
/** Sample change drawn under the list so every highlighted theme is judged on real diff colours. */
const SAMPLE: readonly {n: number; sign: ' ' | '-' | '+'; text: string}[] = [
  {n: 1, sign: ' ', text: ' function greet() {'},
  {n: 2, sign: '-', text: '  console.log("Hello, World!");'},
  {n: 2, sign: '+', text: '  console.log("Hello, Cosmew!");'},
  {n: 3, sign: ' ', text: ' }'},
];
export function ThemesDialog(
  props: DialogProps & {
    scope?: 'global' | 'project';
    onOnboardingSelect?: () => void;
  },
) {
  const {engine, color} = useTheme();
  const client = useFutrynClient();
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
        {props.onOnboardingSelect ? "Let's get started." : 'Theme'}
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
            await engine.setTheme(item.id, props.scope);
            if (!signal.aborted) {
              const notices = client.appearanceNotices();
              if (props.onOnboardingSelect) props.onOnboardingSelect();
              else if (notices.length) task.setMessage(notices.join(' '));
              else router.close();
            }
          })
        }
      />
      <Box height={1} />
      <Rule glyph="╌" color={muted} width={Math.max(1, size.width - 4)} />
      <DiffView
        diff={'@@ -1,3 +1,3 @@\n' + SAMPLE.map(row => row.sign + row.text).join('\n')}
        width={Math.max(8, size.width - 4)}
        language="javascript"
      />
      <Rule glyph="╌" color={muted} width={Math.max(1, size.width - 4)} />
      <TextLine
        color={muted}
      >{` Syntax highlighting: ${engine.getCommittedAppearance().syntaxHighlighting ? 'on' : 'off'}`}</TextLine>
      {task.message ? <TextLine color={color('warning')}>{task.message}</TextLine> : null}
      <Box height={1} />
      <TextLine color={muted}>
        {props.onOnboardingSelect ? 'To change this later, run /theme' : 'Enter to select · Esc to cancel'}
      </TextLine>
      {props.onOnboardingSelect ? <TextLine color={muted}>Enter to select</TextLine> : null}
    </Panel>
  );
}
