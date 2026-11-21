/** @jsxImportSource react */
import {useState} from 'react';
import {Box} from 'ink';
import {useFutrynClient, useKeybindings} from '../../hooks';
import {useTheme} from '../../theme';
import {ListPicker, Panel, PanelTabs, TextLine} from '../../ui';
import {useDialogSize, usePicker, type DialogProps} from '../picker';
import {commandRows, HELP_INTRO, HELP_MORE, shortcutRows} from './logic';
export {commandRows, shortcutRows, HELP_SHORTCUT_COLUMNS} from './logic';
/** Kept for callers that list help entries as picker rows. */
export const helpItems = commandRows;
export interface HelpDialogProps extends DialogProps {
  onCommand?: (command: string) => void;
}
const TABS = ['General', 'Commands', 'Custom commands'] as const;
export function HelpDialog({onCommand, ...props}: HelpDialogProps) {
  const router = usePicker();
  const client = useFutrynClient();
  const {color} = useTheme();
  const size = useDialogSize(props);
  const [tab, setTab] = useState<(typeof TABS)[number]>('General');
  const turn = (step: 1 | -1) => setTab(t => TABS[(TABS.indexOf(t) + (step < 0 ? TABS.length - 1 : 1)) % TABS.length]!);
  useKeybindings({Tabs: {'tabs:next': () => turn(1), 'tabs:previous': () => turn(-1)}});
  const muted = color('foregroundMuted');
  const skills = client.skills().skills;
  return (
    <Panel width={size.width}>
      <PanelTabs title="Help" tabs={TABS} selected={tab} onSelect={value => setTab(value as (typeof TABS)[number])} />
      <Box height={1} />
      {tab === 'General' ? (
        <>
          <TextLine>{HELP_INTRO}</TextLine>
          <Box height={1} />
          <TextLine bold>Shortcuts</TextLine>
          {shortcutRows(size.width).map((row, at) => (
            <TextLine key={at}>{row}</TextLine>
          ))}
          <Box height={1} />
          <TextLine>{HELP_MORE}</TextLine>
        </>
      ) : tab === 'Commands' ? (
        <ListPicker
          key="commands"
          items={commandRows()}
          filterable={false}
          visibleRows={size.visibleRows}
          hint={false}
          onSelect={item => {
            if (onCommand) {
              router.close();
              onCommand(item.id);
            }
          }}
        />
      ) : skills.length ? (
        <ListPicker
          key="custom"
          items={skills.map(skill => ({id: `/${skill.name}`, label: `/${skill.name}`, description: skill.description}))}
          filterable={false}
          visibleRows={size.visibleRows}
          hint={false}
          onSelect={item => {
            if (onCommand) {
              router.close();
              onCommand(item.id);
            }
          }}
        />
      ) : (
        <TextLine color={muted}>
          No custom commands found. Add skills under .cosmew/skills/ or ~/.cosmew/skills/.
        </TextLine>
      )}
      <Box height={1} />
      <TextLine color={muted}>←/→ to switch · Esc to close</TextLine>
    </Panel>
  );
}
