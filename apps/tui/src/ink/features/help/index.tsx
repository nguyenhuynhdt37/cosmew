/** @jsxImportSource react */
import {SLASH_COMMANDS} from '@futryn/sdk';
import {KEYMAP} from '../../hooks';
import {PickerDialog, usePicker, type DialogProps} from '../picker';
export function helpItems() {
  return [
    ...KEYMAP.map(k => ({id: `key:${k.action}`, label: k.keys, description: k.label})),
    ...SLASH_COMMANDS.filter(c => c.help !== false).map(c => ({
      id: c.command,
      label: `${c.command}${c.aliases.length ? ` (${c.aliases.join(', ')})` : ''}`,
      description: `${c.description}${c.shortcut ? ` · ${c.shortcut}` : ''}`,
      keywords: c.category,
    })),
  ];
}
export interface HelpDialogProps extends DialogProps {
  onCommand?: (command: string) => void;
}
export function useHelp() {
  const router = usePicker();
  return {
    ...router,
    items: helpItems(),
    openHelp: (props: HelpDialogProps = {}) => router.open('help', <HelpDialog {...props} />),
  };
}
export function HelpDialog({onCommand, ...props}: HelpDialogProps) {
  const router = usePicker();
  return (
    <PickerDialog
      title="Keyboard & commands"
      {...props}
      items={helpItems()}
      onSelect={item => {
        if (item.id.startsWith('/') && onCommand) {
          router.close();
          onCommand(item.id);
        }
      }}
    />
  );
}
