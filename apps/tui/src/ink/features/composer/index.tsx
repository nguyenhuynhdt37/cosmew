/** @jsxImportSource react */
import {useTerminalSize} from '../../hooks/use-terminal-size';
import {useBindingLabel} from '../../hooks/keymap';
import {Box, Text} from 'ink';
import {useEffect, useMemo, useState, type ReactNode} from 'react';
import {nextGrapheme} from '../../../input/text';
import {useTheme} from '../../theme';
import {Rule, TextLine, leadingSlashCommand, safeText} from '../../ui';
import {useUiTheme} from '../../ui/ui-theme';
import {ComposerFooter, SandboxBanner, SessionModeBanner, contextLeft} from '../status';
import {Autocomplete} from '../autocomplete';
import {History} from '../history';
import {visualRows} from './logic';
import {useComposer, type ComposerController, type ComposerOptions} from './use-composer';
export {useComposer, type ComposerController, type ComposerOptions, type SubmitAcceptance} from './use-composer';
export {visualRows, moveCursor, edit, insertText, verticalMove} from './logic';

/** The first four are the reference's phrases (spec 2); the first is what a fresh input shows. */
export const EXAMPLES = [
  'write a test for <filepath>',
  'fix lint errors',
  'edit <filepath> to…',
  'fix typecheck errors',
  'explain this codebase',
  'review the current diff',
] as const;
/** Editor named in the multi-line hint: `$VISUAL`/`$EDITOR` when set, else the literal variable. */
export function editorName(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.VISUAL || env.EDITOR || '').trim().split(/\s+/)[0] ?? '';
  const name = raw.split('/').pop() ?? '';
  if (!name) return '$EDITOR';
  return (
    (
      {code: 'VS Code', cursor: 'Cursor', vim: 'Vim', nvim: 'Neovim', nano: 'nano', emacs: 'Emacs'} as Record<
        string,
        string
      >
    )[name] ?? name
  );
}
/** Messages typed while a turn runs: `❯ text` on the user background, then the send-now hint (spec 2). */
export function QueuedMessages({messages, width}: {messages: readonly string[]; width: number}) {
  const ui = useUiTheme();
  if (!messages.length) return null;
  return (
    <Box flexDirection="column" width={width} minWidth={0}>
      <Text> </Text>
      {messages.map((message, index) => (
        <Box key={`${index}:${message}`} flexDirection="column" width={width} minWidth={0}>
          <Text wrap="truncate-end" color={ui.color('dim')} backgroundColor={ui.color('userMessage')}>
            {`❯ ${safeText(message).replace(/\s*\n\s*/g, ' ')}`}
          </Text>
          <Text wrap="truncate-end" color={ui.color('dim')}>
            {'  ⎿  Queued · ctrl+x ctrl+s to send now'}
          </Text>
        </Box>
      ))}
      <Text> </Text>
    </Box>
  );
}

function ComposerHint({controller, width, bash}: {controller: ComposerController; width: number; bash: boolean}) {
  const ui = useUiTheme();
  const complete = useBindingLabel('Autocomplete', 'autocomplete:accept');
  const previous = useBindingLabel('Autocomplete', 'autocomplete:previous').split('/')[0]!;
  const next = useBindingLabel('Autocomplete', 'autocomplete:next').split('/')[0]!;
  const dismiss = useBindingLabel('Autocomplete', 'autocomplete:dismiss');
  const send = useBindingLabel('Chat', 'chat:submit');
  const newline = useBindingLabel('Chat', 'chat:newline').split('/')[0]!;
  const mode = useBindingLabel('Chat', 'chat:cycleMode');
  const suggestions = [[previous, next].filter(key => key !== 'unbound').join('/'), 'select'];
  const hints = controller.items.length
    ? [[complete, 'complete'], suggestions, [dismiss, 'dismiss']]
    : [
        [send, controller.busy ? 'queue' : bash ? 'run shell' : 'send'],
        [newline, 'new line'],
        [mode, 'permissions'],
        ...(controller.draft.value
          ? []
          : [['/', 'commands'], ['@', 'files'], ...(controller.vimMode ? [] : [['?', 'shortcuts']])]),
      ];
  return (
    <Box width={width} paddingLeft={2}>
      <Text wrap="truncate-end" color={ui.color('dim')}>
        {controller.vimMode === 'INSERT' ? '-- INSERT -- · ' : null}
        {hints
          .filter(([key]) => key && key !== 'unbound')
          .map(([key, label], index) => (
            <Text key={label}>
              {index ? ' · ' : ''}
              <Text color={ui.color('command')}>{key}</Text> {label}
            </Text>
          ))}
      </Text>
    </Box>
  );
}

export interface ComposerViewProps {
  controller: ComposerController;
  width?: number;
  maxRows?: number;
  placeholder?: string;
  isActive?: boolean;
  /** Show shortcuts that apply to the current input state. */
  showHints?: boolean;
  /** Fullscreen bottom block: fixed effort row, blank row before the footer. */
  fullscreen?: boolean;
  /** Spinner and tip, directly above the effort row. */
  activity?: ReactNode;
  /** Warning line between the lower rule and the footer. */
  warning?: string;
  transcriptHint?: string;
}
/** Controlled view lets Phase 2 share interrupt ownership with InkApp without refs. */
export function ComposerView({
  controller,
  width,
  maxRows = 6,
  placeholder,
  isActive = true,
  showHints = true,
  fullscreen = false,
  activity,
  warning,
  transcriptHint,
}: ComposerViewProps) {
  const {columns, rows: terminalRows} = useTerminalSize();
  const manageKey = useBindingLabel('Chat', 'history:next');
  const {color} = useTheme();
  const ui = useUiTheme();
  const [example, setExample] = useState(0);
  useEffect(() => {
    if (controller.draft.value || !isActive || placeholder) return;
    const timer = setInterval(() => setExample(value => (value + 1) % EXAMPLES.length), 8000);
    return () => clearInterval(timer);
  }, [controller.draft.value, isActive, placeholder]);
  const queued = controller.queued;
  const taskRows = (terminalRows ?? 24) < 24 ? 1 : 3;
  const taskStart = Math.max(0, controller.tasks.findIndex(task => task.id === controller.selectedTask) - taskRows + 1);
  // Running: empty placeholder, or the queue hint when messages wait (spec 2).
  const hint = controller.busy
    ? queued.length
      ? 'Press up to edit queued messages'
      : ''
    : (placeholder ?? `Try "${EXAMPLES[example]}"`);
  // `#` is only a dispatch prefix now: it keeps the normal prompt and rules (spec 2).
  const mode = controller.draft.value.startsWith('!') ? 'bash' : 'prompt';
  const promptColor =
    mode === 'bash' ? ui.color('bashMode') : color(controller.busy ? 'foregroundMuted' : 'foreground');
  const ruleColor = mode === 'bash' ? ui.color('bashMode') : undefined;
  const displayValue = mode === 'prompt' ? controller.draft.value : controller.draft.value.slice(1);
  const slashCommand = mode === 'prompt' ? leadingSlashCommand(displayValue) : null;
  const commandStart = slashCommand?.[1]?.length ?? 0;
  const commandEnd = slashCommand?.[0].length ?? 0;
  const displayCursor = Math.max(0, controller.draft.cursor - (mode === 'prompt' ? 0 : 1));
  const marker = mode === 'bash' ? '! ' : '❯ ';
  const outerWidth = Math.max(1, width ?? columns ?? 80);
  const innerWidth = Math.max(1, outerWidth - 2);
  const {draft, search, items, selected} = controller;
  // Reserve a cell at the wrap edge for the caret.
  const rows = useMemo(() => visualRows(displayValue, innerWidth - 1), [displayValue, innerWidth]);
  const cursorRow = Math.max(
    0,
    rows.findLastIndex(row => row.start <= displayCursor),
  );
  const first = Math.max(0, cursorRow - Math.max(1, maxRows) + 1);
  const anchor = Math.max(0, (draft.selectionAnchor ?? draft.cursor) - (mode === 'prompt' ? 0 : 1));
  const prefixLength = mode === 'prompt' ? 0 : 1;
  const from = controller.vimRange
    ? Math.max(0, controller.vimRange[0] - prefixLength)
    : Math.min(anchor, displayCursor);
  const to = controller.vimRange ? Math.max(0, controller.vimRange[1] - prefixLength) : Math.max(anchor, displayCursor);
  if (outerWidth < 6)
    return (
      <TextLine width={outerWidth} wrap="truncate-end">
        {draft.value || hint}
      </TextLine>
    );
  if (search) {
    const found = search.entries.filter(e => e.content.toLocaleLowerCase().includes(search.query.toLocaleLowerCase()));
    return (
      <Box flexDirection="column" width={outerWidth} minWidth={0}>
        <QueuedMessages messages={queued} width={outerWidth} />
        {activity}
        <History
          query={search.query}
          matches={found.map(e => e.content)}
          timestamps={found.some(e => e.timestamp) ? found.map(e => e.timestamp) : undefined}
          scope={search.scope}
          selected={search.selected}
          width={outerWidth}
          notice={controller.notice || undefined}
        />
      </Box>
    );
  }
  const effort = controller.status.activeModel?.reasoningEfforts?.length
    ? safeText(controller.status.reasoningEffort ?? 'default')
    : '';
  // One right-aligned slot above the rule: the deleted-text hint, the editor hint, else the effort line.
  const slot = controller.slotNotice
    ? controller.slotNotice
    : controller.pasteDeletedHint
      ? 'ctrl+y to paste deleted text'
      : displayValue.includes('\n')
        ? `ctrl+g to edit in ${editorName()}`
        : '';
  return (
    <Box flexDirection="column" width={outerWidth} minWidth={0}>
      <QueuedMessages messages={queued} width={outerWidth} />
      {activity}
      {items.length ? <Autocomplete items={items} selected={selected} width={outerWidth} /> : null}
      {!items.length && (fullscreen || slot || effort) ? (
        // Reference: effort and deleted-text hint end two cells before the edge; the editor hint ends 18 cells before.
        <Box width={outerWidth} justifyContent="flex-end" paddingRight={slot.startsWith('ctrl+g') ? 18 : 2}>
          {slot ? (
            <Text color={ui.color('dim')}>{slot}</Text>
          ) : effort ? (
            <Text color={ui.color('dim')}>
              <Text color={ui.color('thinking')}>{`◐ ${effort}`}</Text> ·{' '}
              <Text color={ui.color('command')}>/effort</Text>
            </Text>
          ) : (
            <Text> </Text>
          )}
        </Box>
      ) : null}
      {controller.images.length ? (
        <Box paddingLeft={2} gap={1} width={outerWidth} flexWrap="wrap">
          {controller.images.map((image, index) => (
            <Text key={image.id} inverse={controller.selectedImage === index} color={ui.color('dim')}>
              {image.label}
            </Text>
          ))}
          <Text color={ui.color('dim')}>← select · delete remove</Text>
        </Box>
      ) : null}
      <Rule width={outerWidth} color={ruleColor} />
      <Box flexDirection="column" width={outerWidth} minWidth={0}>
        {displayValue ? (
          rows.slice(first, first + Math.max(1, maxRows)).map((row, index) => {
            const caret = isActive && cursorRow === first + index;
            const caretOffset = displayCursor - row.start;
            const boundaries = new Set([
              0,
              row.text.length,
              Math.max(0, Math.min(row.text.length, from - row.start)),
              Math.max(0, Math.min(row.text.length, to - row.start)),
            ]);
            for (const boundary of [commandStart, commandEnd]) {
              if (boundary > row.start && boundary < row.start + row.text.length) boundaries.add(boundary - row.start);
            }
            if (caret) {
              boundaries.add(caretOffset);
              boundaries.add(nextGrapheme(row.text, caretOffset));
            }
            const points = [...boundaries].sort((a, b) => a - b);
            return (
              <Box key={first + index} minWidth={0}>
                <Text color={promptColor}>{first + index === 0 ? marker : '  '}</Text>
                <Text wrap="truncate-end" color={color('foreground')}>
                  {points.slice(0, -1).map((start, part) => {
                    const end = points[part + 1]!;
                    const selected = row.start + start >= from && row.start + start < to;
                    const command = row.start + start >= commandStart && row.start + start < commandEnd;
                    const tint = command ? ui.color('command') : undefined;
                    return (
                      <Text key={start} color={tint} inverse={selected || (caret && start === caretOffset)}>
                        {safeText(row.text.slice(start, end))}
                      </Text>
                    );
                  })}
                  {caret && caretOffset === row.text.length ? <Text inverse> </Text> : null}
                </Text>
              </Box>
            );
          })
        ) : (
          <Text wrap="truncate-end">
            <Text color={promptColor}>{marker}</Text>
            <Text color={color('foregroundSubtle')}>
              <Text inverse={isActive}>{safeText(hint).slice(0, 1) || ' '}</Text>
              {safeText(hint).slice(1)}
            </Text>
          </Text>
        )}
      </Box>
      <Rule width={outerWidth} color={ruleColor} />
      {fullscreen && warning ? (
        <Box paddingLeft={2} width={outerWidth}>
          <TextLine width={Math.max(1, outerWidth - 2)} color={color('warning')}>{`⚠ ${warning}`}</TextLine>
        </Box>
      ) : null}
      {!controller.shortcuts && isActive && showHints && (!controller.vimMode || controller.vimMode === 'INSERT') ? (
        <ComposerHint controller={controller} width={outerWidth} bash={mode === 'bash'} />
      ) : controller.vimMode && controller.vimMode !== 'NORMAL' ? (
        <Box width={outerWidth} paddingLeft={2}>
          <Text color={ui.color('dim')}>{`-- ${controller.vimMode} --`}</Text>
        </Box>
      ) : fullscreen && !controller.shortcuts ? (
        <Text> </Text>
      ) : null}
      <SandboxBanner enabled={controller.status.sandbox.enabled} count={controller.status.sandboxBlockedOperations} />
      <SessionModeBanner mode={controller.status.mode} width={outerWidth} />
      {!controller.shortcuts && controller.tasks.length ? (
        <Box flexDirection="column" width={outerWidth} paddingLeft={2} minWidth={0}>
          <Text wrap="truncate-end" color={ui.color('dim')}>
            {`Tasks · ${manageKey} to manage`}
          </Text>
          {controller.tasks.slice(taskStart, taskStart + taskRows).map(task => (
            <Text
              key={task.id}
              wrap="truncate-end"
              inverse={task.id === controller.selectedTask}
              color={ui.color('dim')}
            >
              {`${task.id === controller.selectedTask ? '❯' : '●'} ${task.kind} · ${safeText(task.description).replace(/\s+/g, ' ')}${task.foreground ? '' : ' · background'}`}
            </Text>
          ))}
          {controller.tasks.length > taskRows ? (
            <Text wrap="truncate-end" dimColor>{`${controller.tasks.length} tasks · ←/→ select after ↓`}</Text>
          ) : null}
        </Box>
      ) : null}
      <ComposerFooter
        mode={controller.status.permissionMode}
        bash={mode === 'bash'}
        busy={controller.busy}
        agents={controller.agents}
        shells={controller.backgroundShells}
        width={outerWidth}
        shortcuts={controller.shortcuts ? controller.shortcutColumns : undefined}
        message={controller.notice || controller.completionError}
        remaining={contextLeft(controller.context)}
        context={
          controller.status.selection
            ? {
                usedTokens: controller.context.estimateTokens,
                modelLimitTokens: controller.status.activeModel?.contextLimit ?? null,
              }
            : undefined
        }
        transcriptHint={transcriptHint}
      />
    </Box>
  );
}
export interface ComposerProps extends Omit<ComposerOptions, 'inputWidth'> {
  width?: number;
  maxRows?: number;
  placeholder?: string;
}
export function Composer({width, maxRows, placeholder, ...options}: ComposerProps) {
  const {columns} = useTerminalSize();
  const controller = useComposer({...options, inputWidth: Math.max(1, (width ?? columns ?? 80) - 3)});
  return (
    <ComposerView
      controller={controller}
      width={width}
      maxRows={maxRows}
      placeholder={placeholder}
      isActive={options.isActive}
    />
  );
}
