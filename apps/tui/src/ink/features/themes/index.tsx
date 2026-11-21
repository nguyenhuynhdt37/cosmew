/** @jsxImportSource react */
import {useEffect} from 'react';
import {Box, Text} from 'ink';
import {useFutrynClient} from '../../hooks';
import {useTheme} from '../../theme';
import {useOverlay} from '../../core';
import {CodeBlock, DiffView, ListPicker, Panel, Rule, TextLine, useDialogRows, useUiTheme} from '../../ui';
import {useDialogSize, useDialogTask, type DialogProps} from '../picker';
/** Sample change drawn under the list so every highlighted theme is judged on real diff colours. */
const SAMPLE: readonly {n: number; sign: ' ' | '-' | '+'; text: string}[] = [
  {n: 1, sign: ' ', text: ' function greet() {'},
  {n: 2, sign: '-', text: '  console.log("Hello, World!");'},
  {n: 2, sign: '+', text: '  console.log("Hello, Cosmew!");'},
  {n: 3, sign: ' ', text: ' }'},
];
const SAMPLE_DIFF = '@@ -1,3 +1,3 @@\n' + SAMPLE.map(row => row.sign + row.text).join('\n');
const SYNTAX_OPTION = 'syntax-highlighting';

function ThemePreview({width, compact}: {width: number; compact: boolean}) {
  const {engine, color} = useTheme();
  const ui = useUiTheme();
  const muted = color('foregroundMuted');
  const colors = engine.colorCapability;
  return (
    <Box flexDirection="column" width={width} minWidth={0} backgroundColor={color('background')}>
      <Text bold color={color('markdownHeading')} wrap="truncate-end">
        {`Preview · ${engine.getActiveThemeManifest().name}`}
      </Text>
      <Text wrap="truncate-end" color={muted}>
        <Text color={ui.color('command')}>/config</Text> · <Text color={ui.color('bashMode')}>Bash</Text> ·{' '}
        <Text color={ui.color('thinking')}>✻ Thinking</Text>
      </Text>
      <Text wrap="truncate-end" color={muted}>
        <Text color={color('success')}>✓ Done</Text> ·{' '}
        <Text color={color('warning')}>{compact ? '! Warn' : '! Warning'}</Text> ·{' '}
        <Text color={color('error')}>× Error</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text color={muted}>Terminal colors </Text>
        <Text color={colors === 'none' ? muted : ui.color('command')}>
          {colors === 'none' ? 'Off' : colors === 'truecolor' ? 'Truecolor' : `${colors} colors`}
        </Text>
      </Text>
      <CodeBlock
        code={'echo "$HOME" # shell'}
        language="bash"
        label={false}
        width={width}
        foreground={color('foreground')}
      />
      {compact ? null : <DiffView diff={SAMPLE_DIFF} width={width} language="javascript" />}
    </Box>
  );
}

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
  const dialogRows = useDialogRows();
  useEffect(
    () => () => {
      // Esc, or any other way out, undoes the live preview.
      if (engine.isPreviewing()) engine.cancelPreview();
    },
    [engine],
  );
  const muted = color('foregroundMuted');
  const themes = engine.listThemes('all');
  const {theme: committed, syntaxHighlighting} = engine.getCommittedAppearance();
  const onboarding = !!props.onOnboardingSelect;
  const compact = size.width < 46 || (dialogRows !== undefined && dialogRows < 19);
  const width = Math.max(1, size.width - 4);
  const themeItems = themes.map(theme => ({id: theme.id, label: theme.name, current: theme.id === committed}));
  const items = onboarding
    ? themeItems
    : [
        {
          id: SYNTAX_OPTION,
          label: `Code colors ${syntaxHighlighting ? 'On' : 'Off'}`,
          labelTone: syntaxHighlighting ? ('success' as const) : ('dim' as const),
        },
        ...themeItems,
      ];
  const initialCursor = Math.max(
    0,
    items.findIndex(item => item.id === committed),
  );
  return (
    <Panel width={size.width}>
      <Text bold color={ui.color('rule')}>
        {props.onOnboardingSelect ? "Let's get started." : 'Theme'}
      </Text>
      <Box height={1} />
      <TextLine bold>Choose the text style that looks best with your terminal</TextLine>
      <Box height={1} />
      <ListPicker
        items={items}
        showSearch={false}
        visibleRows={Math.min(size.visibleRows, onboarding ? items.length : compact ? 2 : 5)}
        initialCursor={initialCursor}
        onHighlight={item => {
          if (item.id !== SYNTAX_OPTION) engine.previewTheme(item.id);
        }}
        hint={false}
        onSelect={item =>
          void task.run(async signal => {
            if (item.id === SYNTAX_OPTION) {
              await engine.updateAppearance({syntaxHighlighting: !syntaxHighlighting}, props.scope);
              if (!signal.aborted) task.setMessage(client.appearanceNotices().join(' '));
              return;
            }
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
      <Rule glyph="╌" color={muted} width={width} />
      {onboarding ? (
        <>
          <DiffView diff={SAMPLE_DIFF} width={Math.max(8, width)} language="javascript" />
          <Rule glyph="╌" color={muted} width={width} />
          <TextLine color={muted}>{` Syntax highlighting: ${syntaxHighlighting ? 'on' : 'off'}`}</TextLine>
        </>
      ) : (
        <ThemePreview width={width} compact={compact} />
      )}
      {task.message ? <TextLine color={color('warning')}>{task.message}</TextLine> : null}
      <Box height={1} />
      <TextLine color={muted}>
        {props.onOnboardingSelect ? 'To change this later, run /theme' : '↑/↓ preview · Enter select · Esc cancel'}
      </TextLine>
      {props.onOnboardingSelect ? <TextLine color={muted}>Enter to select</TextLine> : null}
    </Panel>
  );
}
