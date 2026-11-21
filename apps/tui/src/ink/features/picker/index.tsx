/** @jsxImportSource react */
import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import {FutrynError} from '@cosmew/contracts';
import {useOverlay} from '../../core';
import {useClientEvents, useKeymap, useTextInput} from '../../hooks';
import {useTerminalSize} from '../../hooks/use-terminal-size';
import {useTheme} from '../../theme';
import {Panel, PanelTabs, ListPicker, TextLine, KeyHint, safeText, type PickerItem} from '../../ui';
export type DialogProps = {width?: number; visibleRows?: number};
export function usePicker() {
  const {open, close} = useOverlay();
  return {open: useCallback((id: string, content: ReactNode) => open(id, content), [open]), close};
}
/** Keep feature reads event driven; rendering never invokes discovery or other I/O. */
export function useDialogRefresh() {
  const [revision, refresh] = useState(0);
  const update = useCallback(() => refresh(n => n + 1), []);
  useClientEvents({
    reactive: event => {
      if (!['streaming', 'reasoning', 'tool', 'thinking'].includes(event.kind)) update();
    },
    interaction: update,
    subagent: update,
  });
  return {revision, refresh: update};
}
export function useDialogSize({width, visibleRows}: DialogProps) {
  const {columns, rows: reportedRows} = useTerminalSize();
  const rows = reportedRows || 24;
  // Tall terminals keep a half-height list. Short ones must shrink or the choices render past the frame.
  const fitted =
    rows >= 24 ? Math.max(6, Math.min(16, Math.floor((rows - 8) / 2))) : Math.max(1, Math.min(8, rows - 6));
  return {
    width: Math.max(4, Math.min(width ?? (columns || 88), columns || width || 88)),
    visibleRows: Math.max(1, visibleRows ?? fitted),
  };
}
export function Dialog({
  title,
  children,
  message,
  tone,
  ruleStyle,
  ...props
}: DialogProps & {
  title: string;
  children: ReactNode;
  message?: string;
  tone?: 'info' | 'accent';
  ruleStyle?: 'panel' | 'dialog';
}) {
  const size = useDialogSize(props);
  const {color} = useTheme();
  return (
    <Panel title={title} width={size.width} focused tone={tone} ruleStyle={ruleStyle}>
      {children}
      {message ? <TextLine color={color('warning')}>{message}</TextLine> : null}
    </Panel>
  );
}
export function PickerDialog<T extends PickerItem>({
  title,
  items,
  onSelect,
  message,
  children,
  onHighlight,
  hint,
  filterable,
  onTextKey,
  placeholder,
  numbered,
  cursor,
  onCursorChange,
  ...props
}: DialogProps & {
  title: string;
  hint?: string | false;
  filterable?: boolean;
  onTextKey?: (input: string) => boolean;
  placeholder?: string;
  numbered?: boolean;
  /** Controlled highlight (the effort slider moves it with ←/→). */
  cursor?: number;
  onCursorChange?: (index: number) => void;
  onHighlight?: (item: T) => void;
  items: readonly T[];
  onSelect(item: T): void;
  message?: string;
  children?: ReactNode;
}) {
  const size = useDialogSize(props);
  const {selections} = useOverlay();
  return (
    <Dialog title={title} {...size} message={message}>
      {children}
      <ListPicker
        key={title}
        items={items}
        onSelect={onSelect}
        hint={hint}
        filterable={filterable}
        onTextKey={onTextKey}
        placeholder={placeholder}
        numbered={numbered}
        cursor={cursor}
        onCursorChange={onCursorChange}
        initialCursor={Math.max(
          0,
          items.findIndex(item => item.id === selections.get(title)),
        )}
        onHighlight={item => {
          selections.set(title, item.id);
          onHighlight?.(item);
        }}
        visibleRows={size.visibleRows}
      />
    </Dialog>
  );
}
export function TextEntry({
  label,
  onSubmit,
  hidden = false,
  initialValue = '',
  maxLength = 2048,
  allowEmpty = false,
}: {
  label: string;
  onSubmit(value: string): void;
  hidden?: boolean;
  initialValue?: string;
  maxLength?: number;
  allowEmpty?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  useKeymap({
    submit: () => {
      if (allowEmpty || value.trim()) {
        const submitted = value;
        setValue('');
        onSubmit(submitted);
      }
    },
  });
  useTextInput((input, key) => {
    if (
      key.eventType === 'release' ||
      key.ctrl ||
      key.meta ||
      key.escape ||
      key.return ||
      key.tab ||
      key.upArrow ||
      key.downArrow ||
      key.leftArrow ||
      key.rightArrow
    )
      return;
    if (key.backspace || key.delete) setValue(s => Array.from(s).slice(0, -1).join(''));
    else if (input) setValue(s => (s + safeText(input).replace(/\n/g, '')).slice(0, maxLength));
  });
  return (
    <>
      <TextLine>{`${label}: ${hidden ? '•'.repeat(Math.min(24, Array.from(value).length)) : value}▏`}</TextLine>
      <KeyHint keys="Enter Esc" label="save · close" />
    </>
  );
}
export function Detail({text, visibleRows = 10, onBack}: {text: string; visibleRows?: number; onBack?: () => void}) {
  const lines = safeText(text.slice(0, 262144)).split('\n');
  const [offset, setOffset] = useState(0);
  const limit = Math.max(1, visibleRows);
  const max = Math.max(0, lines.length - limit);
  const start = Math.min(offset, max);
  useKeymap({
    submit: onBack,
    previous: () => setOffset(Math.max(0, start - 1)),
    next: () => setOffset(Math.min(max, start + 1)),
  });
  return (
    <>
      <TextLine>{lines.slice(start, start + limit).join('\n')}</TextLine>
      <TextLine>{`${start + 1}–${Math.min(lines.length, start + limit)}/${lines.length}${text.length > 262144 ? ' · truncated' : ''}`}</TextLine>
    </>
  );
}
export function describeDialogError(error: unknown): string {
  return error instanceof FutrynError
    ? error.code === 'UNSUPPORTED'
      ? `${error.code}: ${error.message}`
      : `${error.code}: Action failed; review current state and retry.`
    : 'Action failed; review current state and retry.';
}
/** One task per dialog; close aborts work and late completions cannot mutate UI. */
export function useDialogTask() {
  const {tasks} = useOverlay();
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);
  const run = async (task: (signal: AbortSignal) => Promise<void> | void) => {
    if (active.current || !mounted.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setMessage('');
    let finish!: () => void;
    const pending = new Promise<void>(resolve => {
      finish = resolve;
    });
    tasks.set(controller, pending);
    try {
      await task(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted && mounted.current) setMessage(describeDialogError(error));
    } finally {
      finish();
      tasks.delete(controller);
      if (active.current === controller) active.current = null;
      if (mounted.current) setBusy(false);
    }
  };
  return {run, busy, message, setMessage};
}

/** Input stays with the feature so tabs cannot steal text-entry or approval keys. */
export function DialogTabs({tabs, selected, title}: {tabs: readonly string[]; selected: string; title?: string}) {
  return <PanelTabs title={title} tabs={tabs} selected={selected} />;
}
