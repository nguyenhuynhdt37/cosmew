/** @jsxImportSource react */
import {Text} from 'ink';
import {useUiTheme} from './ui-theme';
import {safeText} from './text-line';
export interface PanelTabsProps {
  /** Bold, rule coloured first word (`Settings`, `Help`, `Permissions`). */
  title?: string;
  tabs: readonly string[];
  /** The selected tab is drawn reversed with one space of padding on both sides. */
  selected: string;
}
/** Tab bar of the command panels: `Settings  Status   Config   Usage   Stats` (spec 7). */
export function PanelTabs({title, tabs, selected}: PanelTabsProps) {
  const ui = useUiTheme();
  const rule = ui.color('rule');
  return (
    <Text>
      {title ? (
        <Text bold color={rule}>
          {safeText(title)}
        </Text>
      ) : null}
      {tabs.map((tab, at) => (
        <Text key={tab}>
          {title || at ? ' ' : ''}
          <Text bold={tab === selected} inverse={tab === selected} color={tab === selected ? rule : undefined}>
            {` ${safeText(tab)} `}
          </Text>
        </Text>
      ))}
    </Text>
  );
}
