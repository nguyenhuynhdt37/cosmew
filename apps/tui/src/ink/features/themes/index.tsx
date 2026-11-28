/** @jsxImportSource react */
import {useState} from 'react';
import {Box, Text} from 'ink';
import {useBindingLabel, useFutrynClient, useKeybindings} from '../../hooks';
import {ThemePreviewScope, useTheme} from '../../theme';
import {useOverlay} from '../../core';
import {DiffView, ListPicker, Panel, Rule, TextLine, useDialogRows, useUiTheme} from '../../ui';
import {useDialogSize, useDialogTask, type DialogProps} from '../picker';
import {firstChordLabel, initialTab, sideListWidth, slotMode, stepTab, themeLayout, type ThemeTab} from './logic';
import {SAMPLE_DIFF, ThemePreview} from './preview';

const SYNTAX_OPTION = 'syntax-highlighting';

/**
 * `/theme`: GitHub-style theme list with a dialog-local preview (ADR 0127). Highlighting a theme only changes
 * this dialog's state; the engine, and so the rest of the app, changes once, on Enter. Tab moves between a
 * single theme and the day/night slots of Sync with system.
 */
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
  const muted = color('foregroundMuted');
  const appearance = engine.getCommittedAppearance();
  const {syntaxHighlighting} = appearance;
  const systemDark = engine.previewModeFor('auto') === 'dark';
  const onboarding = !!props.onOnboardingSelect;
  const [tab, setTab] = useState<ThemeTab>(() =>
    onboarding ? 'single' : initialTab(appearance.syncWithSystem, systemDark),
  );
  const slotTheme = (which: ThemeTab) =>
    engine.normalizeThemeId(
      which === 'day' ? appearance.lightTheme : which === 'night' ? appearance.darkTheme : appearance.theme,
    );
  const [highlighted, setHighlighted] = useState(() => slotTheme(tab));
  const moveTab = (step: 1 | -1) => {
    const next = stepTab(tab, step);
    setTab(next);
    setHighlighted(slotTheme(next));
  };
  useKeybindings({Tabs: {'tabs:next': () => moveTab(1), 'tabs:previous': () => moveTab(-1)}}, {isActive: !onboarding});
  const tabKey = firstChordLabel(useBindingLabel('Tabs', 'tabs:next'));

  const layout = themeLayout(size.width, dialogRows);
  const compact = layout === 'compact';
  /** Small terminals drop spacer rows; onboarding keeps its established layout. */
  const tight = compact && !onboarding;
  const width = Math.max(1, size.width - 4);
  const side = layout === 'side' && !onboarding;
  const listWidth = side ? sideListWidth(width) : width;
  const previewWidth = side ? Math.max(1, width - listWidth - 2) : width;
  const current = slotTheme(tab);
  const themes = engine
    .listThemes('all')
    .filter(theme => tab === 'single' || (theme.id !== 'auto' && engine.previewModeFor(theme.id) === slotMode(tab)));
  const themeItems = themes.map(theme => ({id: theme.id, label: theme.name, current: theme.id === current}));
  const items =
    onboarding || tab !== 'single'
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
    items.findIndex(item => item.id === current),
  );
  const visibleRows = Math.min(size.visibleRows, onboarding ? items.length : compact ? 2 : side ? 10 : 5);
  // Short terminals: the title, mode switch, slots and list come first; the preview gets the rows left over.
  const previewLines =
    tight && dialogRows !== undefined
      ? dialogRows -
        (1 +
          1 +
          1 +
          (tab === 'single' ? 0 : 2) +
          Math.min(visibleRows, items.length) +
          2 +
          1 +
          1 +
          (task.message ? 1 : 0))
      : undefined;
  const picker = (
    <ListPicker
      key={tab}
      items={items}
      showSearch={false}
      visibleRows={visibleRows}
      initialCursor={initialCursor}
      onHighlight={item => {
        if (item.id !== SYNTAX_OPTION) setHighlighted(item.id);
      }}
      hint={false}
      onSelect={item =>
        void task.run(async signal => {
          if (item.id === SYNTAX_OPTION) {
            await engine.updateAppearance({syntaxHighlighting: !syntaxHighlighting}, props.scope);
            if (!signal.aborted) task.setMessage(client.appearanceNotices().join(' '));
            return;
          }
          if (tab === 'single') await engine.setTheme(item.id, props.scope);
          else
            await engine.setSync({enabled: true, [tab === 'day' ? 'lightTheme' : 'darkTheme']: item.id}, props.scope);
          if (!signal.aborted) {
            const notices = client.appearanceNotices();
            if (props.onOnboardingSelect) props.onOnboardingSelect();
            else if (notices.length) task.setMessage(notices.join(' '));
            else router.close();
          }
        })
      }
    />
  );
  const preview = (
    <ThemePreviewScope themeId={highlighted}>
      {onboarding ? (
        <DiffView diff={SAMPLE_DIFF} width={Math.max(8, width)} language="javascript" />
      ) : (
        <ThemePreview width={previewWidth} compact={compact} maxLines={previewLines} />
      )}
    </ThemePreviewScope>
  );
  const slotRow = (which: 'day' | 'night') => {
    const name = engine.getTheme(slotTheme(which))?.name ?? slotTheme(which);
    const active = (which === 'night') === systemDark ? ' (active)' : '';
    const focused = tab === which;
    return (
      <Text key={which} wrap="truncate-end" color={focused ? ui.color('selected') : muted}>
        {`${focused ? '❯' : ' '} ${which === 'day' ? 'Day' : 'Night'} theme: ${name}${active}`}
      </Text>
    );
  };
  return (
    <Panel width={size.width}>
      <Text bold color={ui.color('rule')}>
        {onboarding ? "Let's get started." : 'Theme'}
      </Text>
      {tight ? null : (
        <>
          <Box height={1} />
          <TextLine bold>Choose the text style that looks best with your terminal</TextLine>
          <Box height={1} />
        </>
      )}
      {onboarding ? null : (
        <>
          <Text wrap="truncate-end">
            <Text color={tab === 'single' ? ui.color('selected') : muted}>
              {tab === 'single' ? '◉' : '○'} Single theme
            </Text>
            {'  '}
            <Text color={tab === 'single' ? muted : ui.color('selected')}>
              {tab === 'single' ? '○' : '◉'} Sync with system
            </Text>
          </Text>
          {tab === 'single' ? null : [slotRow('day'), slotRow('night')]}
          {tight ? null : <Box height={1} />}
        </>
      )}
      {side ? (
        <Box flexDirection="row" width={width}>
          <Box flexDirection="column" width={listWidth} flexShrink={0}>
            {picker}
          </Box>
          <Box width={2} flexShrink={0} />
          {preview}
        </Box>
      ) : (
        <>
          {picker}
          {tight ? null : <Box height={1} />}
          <Rule glyph="╌" color={muted} width={width} />
          {preview}
          {onboarding ? (
            <>
              <Rule glyph="╌" color={muted} width={width} />
              <TextLine color={muted}>{` Syntax highlighting: ${syntaxHighlighting ? 'on' : 'off'}`}</TextLine>
            </>
          ) : null}
        </>
      )}
      {task.message ? <TextLine color={color('warning')}>{task.message}</TextLine> : null}
      {tight ? null : <Box height={1} />}
      <TextLine color={muted} wrap={tight ? 'truncate-end' : undefined}>
        {onboarding
          ? 'To change this later, run /theme'
          : tight
            ? `${tabKey ? `${tabKey} · ` : ''}↑/↓ · Enter · Esc`
            : `${tabKey ? `${tabKey} Single / Day / Night · ` : ''}↑/↓ preview · Enter select · Esc cancel`}
      </TextLine>
      {onboarding ? <TextLine color={muted}>Enter to select</TextLine> : null}
    </Panel>
  );
}
