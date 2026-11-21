/** @jsxImportSource react */
import {Box, Text} from 'ink';
import {MouseRow} from './mouse-row';
import {useUiTheme} from './ui-theme';
import {safeText} from './text-line';
export interface PanelTabsProps {
  /** Bold, rule coloured first word (`Settings`, `Help`, `Permissions`). */
  title?: string;
  tabs: readonly string[];
  /** The selected tab is drawn reversed with one space of padding on both sides. */
  selected: string;
  onSelect?: (tab: string) => void;
  isActive?: boolean;
}
/** Tab bar of the command panels: `Settings  Status   Config   Usage   Stats` (spec 7). */
export function PanelTabs({title, tabs, selected, onSelect, isActive = true}: PanelTabsProps) {
  const ui = useUiTheme();
  const rule = ui.color('rule');
  return (
    <Box flexWrap="wrap">
      {title ? (
        <Text bold color={rule}>
          {safeText(title)}
        </Text>
      ) : null}
      {tabs.map((tab, at) => (
        <MouseRow
          key={tab}
          marginLeft={title || at ? 1 : 0}
          onHighlight={onSelect ? () => onSelect(tab) : undefined}
          isActive={isActive}
        >
          <Text bold={tab === selected} inverse={tab === selected} color={tab === selected ? rule : undefined}>
            {` ${safeText(tab)} `}
          </Text>
        </MouseRow>
      ))}
    </Box>
  );
}
