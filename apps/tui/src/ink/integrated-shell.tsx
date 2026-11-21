/** @jsxImportSource react */
import {useTerminalSize} from './hooks/use-terminal-size';
import {useTerminalWheel} from './hooks/use-terminal-wheel';
import {useEffect, useRef, useState, type ReactNode} from 'react';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Box, Text, renderToString, useApp, useStdout, type DOMElement} from 'ink';
import {BYPASS_PERMISSIONS_WARNING, FutrynError, type ToolCall, type ToolResult} from '@cosmew/contracts';
import {useOverlay} from './core';
import {
  InputScope,
  ensureKeybindingsFile,
  keybindingsPath,
  keymapStore,
  loadKeybindings,
  useClientEvents,
  useFutrynClient,
  useKeyRouter,
  useKeybindings,
  useTextInput,
} from './hooks';
import {useTheme} from './theme';
import {Panel, TextLine, safeText, spinnerTip} from './ui';
import {readMacClipboardImage} from '../clipboard';
import {Welcome} from './features/welcome';
import {StartupGate, useStartupGate} from './features/startup-gate';
import {
  PromptAnchors,
  SearchAnchors,
  Transcript,
  isThinking,
  rowWithin,
  transcriptPlainText,
  useDetailedTranscript,
  useTranscript,
  type TranscriptItem,
} from './features/transcript';
import {
  buildSearchIndexAsync,
  findMatchesAsync,
  searchStatus,
  type SearchIndex,
  type SearchMatch,
} from './features/transcript/search';
import {TranscriptLegend} from './features/transcript/legend';
import {SearchBar} from './features/transcript/search-bar';
import {DetailedFooter} from './features/transcript/detailed-footer';
import {DETAILED_RECENT_LIMIT} from './features/transcript/show-all';
import {ComposerView, useComposer, editorName} from './features/composer';
import {Plan, usePlan} from './features/plan';
import {Notices, useNotices} from './features/notices';
import {Subagents, useSubagents} from './features/subagents';
import {useStatusLine} from './features/status';
import {PermissionRequestDialog, PermissionRulesDialog, usePermissions} from './features/permissions';
import {QuestionRequestDialog} from './features/question';
import {ConnectDialog} from './features/connect';
import {ModelsDialog, EffortDialog} from './features/models';
import {SessionsDialog} from './features/sessions';
import {SettingsDialog} from './features/settings';
import type {SettingsSection, SettingsTab} from './features/settings/logic';
import {createPasteState} from './features/paste';
import {
  HooksDialog,
  McpDialog,
  RESULT_PREFIX,
  RewindDialog,
  cancelledResult,
  closedResult,
  commandResult,
  type CommandResultLines,
} from './features/panels';
import {ThemesDialog} from './features/themes';
import {HelpDialog} from './features/help';
import {MemoryDialog} from './features/memory';
import {AgentsDialog} from './features/agents';
import {SkillsDialog} from './features/skills';
import {Usage, contextBlock, useUsage, type ReportKind} from './features/usage';
import {DiffSidePanel, useDiff, diffPanelLayout, DIFF_PANEL_RESIZE_MESSAGE, changeReceipt} from './features/diff';
import {BackgroundTasksDialog} from './features/background-tasks';
import {PlanApprovalDialog} from './features/plan-approval';
import {routeCommand, type CommandHost} from './features/commands';
import {ScrollViewport, useLiveRows, useScrollback} from './screen';
import {LiveDialog, Spinner} from './ui';

export interface IntegratedShellProps {
  width?: number;
  /** Used only when the output stream does not report a positive row count. */
  rows?: number;
  initialCommand?: string;
  registerShutdown?: (shutdown: () => Promise<void>) => void;
}
/** `/status`, `/usage` and `/cost` are tabs of one settings panel; `/context` has its own grid view. */
function ReportDialog({kind, width, tab}: {kind: ReportKind; width?: number; tab?: SettingsTab}) {
  const {close} = useOverlay();
  const state = useUsage({kind, onClose: close});
  if (kind !== 'context')
    return <SettingsDialog width={width} initialTab={tab ?? (kind === 'status' ? 'Status' : 'Usage')} />;
  return <Usage state={state} width={width} />;
}
/** Transcript lines of a command result: the user-message line and the `⎿` text without its connector. */
function resultParts(result: CommandResultLines): [string, string[]] {
  return [
    result.prompt.replace(/^❯ /, ''),
    result.result.map(line => (line.startsWith(RESULT_PREFIX) ? line.slice(RESULT_PREFIX.length) : line.slice(5))),
  ];
}
/** What Esc prints when it dismisses the panel a slash command opened (spec 7). */
function dismissalResult(route: string, raw: string): CommandResultLines {
  switch (route) {
    case 'sessions':
      return cancelledResult(raw, 'Resume');
    case 'models':
      return cancelledResult(raw, 'Model picker');
    case 'effort':
      return cancelledResult(raw, 'Effort');
    case 'themes':
      return cancelledResult(raw, 'Theme picker');
    case 'rewind':
      return cancelledResult(raw, 'Rewind');
    case 'connect':
    case 'accounts':
    case 'switch':
    case 'logout':
      return cancelledResult(raw, 'Account');
    case 'diff':
      return commandResult(raw, 'Diff panel hidden');
    default:
      return closedResult(raw, route === 'settings' ? 'config' : route);
  }
}
function HistoryDialog({
  items,
  initialOffset = 0,
  width,
}: {
  items: readonly TranscriptItem[];
  initialOffset?: number;
  width?: number;
}) {
  const [offset, setOffset] = useState(initialOffset);
  useTextInput((_input, key) => {
    if (key.pageUp || key.home)
      setOffset(n => (key.home ? Math.max(0, items.length - 8) : Math.min(Math.max(0, items.length - 8), n + 8)));
    if (key.pageDown || key.end) setOffset(n => (key.end ? 0 : Math.max(0, n - 8)));
  });
  return (
    <Panel title="Transcript history" width={width}>
      <Transcript items={items} historyOffset={offset} liveItems={8} isActive animate={false} />
      <TextLine>PgUp/PgDn Home/End · page · ↑↓ focus · Ctrl+O expand · Esc close</TextLine>
    </Panel>
  );
}
function requestFailure(error: unknown): string {
  if (!(error instanceof FutrynError)) return 'Request failed [ERROR]. Run /doctor for safe connection diagnostics.';
  const hint =
    error.code === 'AUTH'
      ? 'No active provider account or model selected. Run /login or /model.'
      : error.code === 'UNSUPPORTED'
        ? 'This model does not accept workspace tools. Tools are now off for it; send your message again.'
        : '';
  return `Request failed [${error.code}].${hint ? ' ' + hint : ''}`;
}
/** Owns SDK tasks; feature views never start a second agent loop or grant permissions. */
export function IntegratedShell({
  width: requestedWidth,
  rows: requestedRows,
  initialCommand,
  registerShutdown,
}: IntegratedShellProps) {
  const client = useFutrynClient();
  const overlay = useOverlay();
  const {exit, suspendTerminal} = useApp();
  const {stdout} = useStdout();
  const router = useKeyRouter();
  const anchors = useRef(new Map<string, DOMElement>());
  const dialogPress = useRef<{key: string; at: number} | null>(null);
  const {engine} = useTheme();
  const {columns} = useTerminalSize();
  const screenRows = useLiveRows(requestedRows);
  const fullscreen = screenRows !== undefined;
  const width = Math.max(1, requestedWidth ?? columns);
  const transcript = useTranscript();
  const detail = useDetailedTranscript();
  const [showAll, setShowAll] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [viewerStatus, setViewerStatus] = useState<string>();
  const transcriptEditorName =
    (process.env.VISUAL || process.env.EDITOR || '').trim().split(/\s+/)[0]?.split('/').pop() || undefined;
  useEffect(() => {
    if (!viewerStatus) return;
    const timer = setTimeout(() => setViewerStatus(undefined), 4000);
    return () => clearTimeout(timer);
  }, [viewerStatus]);
  // Fullscreen owns a paged history window; use upstream's virtual-scroll branch (B4/B7).
  // Equivalence to upstream's render-range virtualizer: Needs verification.
  const virtualScrollActive = fullscreen;
  const diff = useDiff();
  const [diffOpen, setDiffOpen] = useState(false);
  const diffLayout = diffPanelLayout(width, diffOpen);
  const contentWidth = diffLayout.mainWidth;
  const autoDiffOpened = useRef(false);
  const notices = useNotices();
  const plan = usePlan();
  const agents = useSubagents();
  const permissions = usePermissions();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [olderPages, setOlderPages] = useState(0);
  const scroll = useScrollback(() => setOlderPages(n => n + 1));
  useTerminalWheel(
    event => {
      const delta = -event.direction * 3;
      scroll.scrollBy(delta);
      if (delta > 0 && scroll.back + delta >= scroll.maxBack && transcript.items.length > 60 + olderPages * 40)
        setOlderPages(n => n + 1);
    },
    fullscreen && ready && !overlay.active,
  );
  const [section, setSection] = useState<SettingsSection>('General');
  const turn = useRef<AbortController | null>(null);
  const pending = useRef<Promise<void>>(Promise.resolve());
  const closing = useRef(false);
  /** Raw slash command being routed: its notices become `⎿` result lines in the transcript. */
  const routing = useRef<string | undefined>(undefined);
  /** Panel a slash command opened, so Esc can print `⎿  <noun> cancelled`. */
  const opened = useRef<{id: string; route: string; raw: string} | null>(null);
  const closePanel = useRef(() => {});
  const sendNow = useRef(false);
  const editing = useRef(false);
  const commands = useRef(new Map<AbortController, Promise<void>>());
  const mounted = useRef(true);
  const started = useRef(false);
  const session = useRef(client.activeSession()?.id);
  const shellCall = useRef<ToolCall | null>(null);
  const controls = useRef<{interrupt(): boolean; shutdown(): Promise<void>} | null>(null);
  const current = useRef<{shutdown(): Promise<void>; command(raw: string): Promise<void>} | null>(null);
  const reset = () => {
    transcript.reset();
    setDiffOpen(false);
    autoDiffOpened.current = false;
    session.current = client.activeSession()?.id;
    setOlderPages(0);
    scroll.toBottom();
    notices.clearNotices();
  };
  const requestExit = () => {
    if (closing.current) return;
    closing.current = true;
    void current.current?.shutdown().finally(() => exit());
  };
  const open = (route: string, args?: string) => {
    if (closing.current) return;
    if (!ready && route !== 'connect' && route !== 'models') return;
    const changed = () => reset();
    const show = (id: string, content: ReactNode) => {
      opened.current = routing.current ? {id, route, raw: routing.current} : null;
      overlay.open(id, content);
    };
    const accountId = args
      ? (client
          .listAccounts()
          .find(account => account.id === args || account.alias.toLowerCase() === args.toLowerCase())?.id ?? args)
      : undefined;
    switch (route) {
      case 'connect':
      case 'accounts':
      case 'switch':
      case 'logout':
        show(
          'connect',
          <ConnectDialog
            width={width}
            initialStep={route === 'connect' ? 'provider' : 'accounts'}
            action={route === 'logout' ? 'logout' : route === 'switch' ? 'switch' : undefined}
            accountId={accountId}
            onChanged={changed}
            isStreaming={busy}
          />,
        );
        break;
      case 'models':
        show(route, <ModelsDialog width={width} onChanged={changed} isStreaming={busy} />);
        break;
      case 'effort':
        show(route, <EffortDialog width={width} />);
        break;
      case 'sessions':
        show(route, <SessionsDialog width={width} onChanged={changed} />);
        break;
      case 'themes':
        show(route, <ThemesDialog width={width} />);
        break;
      case 'settings':
        show(
          route,
          <SettingsDialog
            width={width}
            initialSection={section}
            onSectionChange={setSection}
            onNavigate={action => open(action)}
            isStreaming={busy}
          />,
        );
        break;
      case 'help':
        show(
          route,
          <HelpDialog
            width={width}
            onCommand={raw => {
              overlay.close();
              void current.current?.command(raw);
            }}
          />,
        );
        break;
      case 'permissions':
        show('permissions', <PermissionRulesDialog width={width} />);
        break;
      case 'background-tasks':
        show(route, <BackgroundTasksDialog width={width} />);
        break;
      case 'agents':
        show(route, <AgentsDialog width={width} />);
        break;
      case 'memory':
        show(route, <MemoryDialog width={width} />);
        break;
      case 'skills':
        show(
          route,
          <SkillsDialog
            width={width}
            onInvoke={raw => {
              overlay.close();
              submit(raw);
            }}
          />,
        );
        break;
      case 'context':
        // Claude Code prints the grid into the transcript; mid-turn it would land inside the running answer.
        if (!turn.current && !shellCall.current) {
          transcript.addContext(routing.current ?? '/context', contextBlock(client));
          break;
        }
        show(route, <ReportDialog kind={route} width={width} />);
        break;
      case 'usage':
      case 'status':
        show(route, <ReportDialog kind={route} width={width} />);
        break;
      case 'cost':
        show('usage', <ReportDialog kind="usage" tab="Stats" width={width} />);
        break;
      case 'rewind':
        show(route, <RewindDialog width={width} onCancel={() => closePanel.current()} />);
        break;
      case 'mcp':
        show(route, <McpDialog width={width} />);
        break;
      case 'hooks':
        show(route, <HooksDialog width={width} />);
        break;
      case 'diff':
        if (width < 110) commandNotice(DIFF_PANEL_RESIZE_MESSAGE);
        else if (diffOpen) {
          setDiffOpen(false);
          commandNotice('Diff panel hidden');
        } else {
          setDiffOpen(true);
          void diff.refresh();
        }
        break;
      case 'keybindings':
        void editKeybindings();
        break;
      default:
        notices.addNotice(`Not implemented: ${route}`);
    }
  };
  const gate = useStartupGate({
    overlayOpen: Boolean(overlay.active),
    openOverlay: open,
    onExit: requestExit,
    onReady: () => {
      setReady(true);
      client.setUserInputAvailable(true);
    },
  });
  const shutdown = async () => {
    turn.current?.abort();
    for (const abort of commands.current.keys()) abort.abort();
    for (const abort of overlay.tasks.keys()) abort.abort();
    controls.current?.interrupt();
    client.setUserInputAvailable(false);
    client.revokeToolGrants();
    for (const req of client.listPendingPermissions()) client.dismissPermissionDialog(req.approvalId);
    for (const req of client.listPendingQuestions()) client.dismissQuestion(req.questionId);
    await gate.shutdown();
    await pending.current;
    await controls.current?.shutdown();
    await Promise.allSettled(commands.current.values());
    await Promise.allSettled(overlay.tasks.values());
    client.setToolsEnabled(false);
    if (engine.isPreviewing()) engine.cancelPreview();
  };
  const submit = (text: string): boolean => {
    if (!ready || closing.current || turn.current || !client.toolsEnabled()) return false;
    const abort = new AbortController();
    turn.current = abort;
    scroll.toBottom();
    setBusy(true);
    pending.current = (async () => {
      let prompt: string | undefined = text;
      while (
        prompt !== undefined &&
        (prompt.trim() || client.imageAttachments().length) &&
        !closing.current &&
        !abort.signal.aborted
      ) {
        const displayPrompt = [prompt, ...client.imageAttachments().map(image => image.label)]
          .filter(Boolean)
          .join('\n');
        transcript.begin(displayPrompt, undefined, status.status.selection?.modelId);
        try {
          for await (const event of client.sendMessage(prompt, {signal: abort.signal})) {
            if (mounted.current) {
              transcript.applyEvent(event);
              if (event.type === 'toolResult' && changeReceipt(event.result).changes.length) {
                if (width >= 110 && !autoDiffOpened.current) {
                  autoDiffOpened.current = true;
                  setDiffOpen(true);
                }
                void diff.refresh();
              }
            }
          }
          transcript.finish({cancelled: abort.signal.aborted || sendNow.current});
        } catch (error) {
          transcript.finish(
            abort.signal.aborted || sendNow.current ? {cancelled: true} : {error: requestFailure(error)},
          );
        }
        session.current = client.activeSession()?.id;
        prompt = abort.signal.aborted ? undefined : client.takeQueuedMessage();
      }
    })().finally(() => {
      turn.current = null;
      if (mounted.current) setBusy(false);
      // Ctrl+X Ctrl+S: the interrupted turn is over; the queued messages go out as the next turn.
      if (sendNow.current) {
        sendNow.current = false;
        const next = !closing.current && mounted.current ? client.takeQueuedMessage() : undefined;
        if (next !== undefined) submit(next);
      }
    });
    return true;
  };
  const sendQueuedNow = () => {
    if (!client.queuedInput().length) {
      notices.addNotice('Nothing queued to send.');
      return;
    }
    sendNow.current = true;
    const disposition = client.sendQueuedNow();
    if (disposition === 'idle' && !turn.current) {
      sendNow.current = false;
      const next = client.takeQueuedMessage();
      if (next !== undefined) submit(next);
    }
  };
  /** Hand the terminal to $VISUAL/$EDITOR on `file`; true when the editor exited cleanly. */
  const runEditor = async (file: string): Promise<boolean> => {
    const [bin, ...args] = (process.env.VISUAL || process.env.EDITOR || 'vi').trim().split(/\s+/);
    let failed = false;
    await suspendTerminal(async () => {
      await new Promise<void>(resolve => {
        const child = spawn(bin!, [...args, file], {stdio: 'inherit'});
        child.once('error', () => {
          failed = true;
          resolve();
        });
        child.once('exit', code => {
          failed = code !== 0;
          resolve();
        });
      });
    });
    return !failed;
  };
  /** Ctrl+G: edit the draft in $VISUAL/$EDITOR on a private temp file while Ink hands over the terminal. */
  const editInExternalEditor = async () => {
    if (editing.current || process.platform === 'win32') {
      if (process.platform === 'win32') notices.addNotice('Not implemented: external editor on Windows.');
      return;
    }
    editing.current = true;
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), 'futryn-edit-'));
      const file = join(dir, 'prompt.md');
      await writeFile(file, composer.content, {mode: 0o600});
      if (!(await runEditor(file))) notices.addNotice('The editor did not exit cleanly; the draft is unchanged.');
      else composer.setDraft(createPasteState((await readFile(file, 'utf8')).replace(/\n$/, '')));
    } catch {
      notices.addNotice('Could not open the editor; the draft is unchanged.');
    } finally {
      editing.current = false;
      if (dir) await rm(dir, {recursive: true, force: true}).catch(() => {});
    }
  };
  /** Edit a private copy; only the SDK may publish a new pending plan revision. */
  const editPlanInExternalEditor = async (plan: string): Promise<string | undefined> => {
    if (editing.current) return;
    if (process.platform === 'win32') throw new Error('External editor on Windows is unavailable.');
    editing.current = true;
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), 'futryn-plan-edit-'));
      const file = join(dir, 'plan.md');
      await writeFile(file, plan, {mode: 0o600});
      if (!(await runEditor(file))) throw new Error('The editor did not exit cleanly; plan unchanged.');
      const text = await readFile(file, 'utf8');
      return text === plan ? undefined : text;
    } finally {
      editing.current = false;
      if (dir) await rm(dir, {recursive: true, force: true}).catch(() => {});
    }
  };
  /** `v` in the transcript viewer: the conversation as text in $VISUAL/$EDITOR (a copy; edits are discarded). */
  const openTranscriptInEditor = async () => {
    if (editing.current) return;
    setLegendOpen(false);
    if (!(process.env.VISUAL || process.env.EDITOR || '').trim()) {
      setViewerStatus('no $VISUAL/$EDITOR set');
      return;
    }
    if (process.platform === 'win32') {
      notices.addNotice('Not implemented: external editor on Windows.');
      return;
    }
    editing.current = true;
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), 'futryn-transcript-'));
      const file = join(dir, 'transcript.md');
      await writeFile(file, transcriptPlainText(transcript.items) + '\n', {mode: 0o600});
      if (!(await runEditor(file))) notices.addNotice('The editor did not exit cleanly.');
    } catch {
      notices.addNotice('Could not open the editor.');
    } finally {
      editing.current = false;
      if (dir) await rm(dir, {recursive: true, force: true}).catch(() => {});
    }
  };
  /** `/keybindings`: create the user file from the template when missing, edit it, then reload it right away. */
  const editKeybindings = async () => {
    if (editing.current) return;
    if (process.platform === 'win32') {
      notices.addNotice('Not implemented: external editor on Windows.');
      return;
    }
    editing.current = true;
    const file = keybindingsPath();
    try {
      const created = ensureKeybindingsFile(file);
      if (created) notices.addNotice(`Created ${file} from the template.`);
      if (!(await runEditor(file))) notices.addNotice('The editor did not exit cleanly.');
      keymapStore.set(loadKeybindings(file));
    } catch {
      notices.addNotice(`Could not open ${file} in an editor.`);
    } finally {
      editing.current = false;
    }
  };
  /** `[` in the transcript viewer: leave the alternate screen and print the conversation into the native scrollback. */
  const dumpScrollback = async () => {
    if (!fullscreen) {
      notices.addNotice('The conversation is already in the terminal scrollback.');
      return;
    }
    const text = transcriptPlainText(transcript.items);
    await suspendTerminal(() => {
      stdout.write(`${text}\n`);
    });
    notices.addNotice('Conversation written to the terminal scrollback.');
  };
  /** `{` / `}`: scroll the detailed transcript to the previous / next prompt. */
  const jumpPrompt = (direction: -1 | 1) => {
    const content = scroll.content.current;
    if (!fullscreen || !content) {
      notices.addNotice('Not implemented: prompt jumps need the fullscreen transcript.');
      return;
    }
    const tops = [...anchors.current.values()].map(el => rowWithin(el, content)).sort((a, b) => a - b);
    const here = scroll.topRow;
    const target = direction < 0 ? tops.findLast(top => top < here) : tops.find(top => top > here);
    if (target === undefined) notices.addNotice(direction < 0 ? 'No earlier prompt.' : 'No later prompt.');
    else scroll.showRow(target);
  };
  /** Ctrl+Z: stop the process after Ink releases the terminal; SIGCONT (fg) brings the screen back. */
  const suspendProcess = () => {
    if (process.platform === 'win32') return;
    void suspendTerminal(
      () =>
        new Promise<void>(resolve => {
          process.once('SIGCONT', () => resolve());
          process.kill(process.pid, 'SIGTSTP');
        }),
    );
  };
  /** Notices raised while a command runs become its `⎿` result in the transcript; mid-turn they stay out of it. */
  const printResult = (result: CommandResultLines) => {
    const [prompt, lines] = resultParts(result);
    transcript.addCommand(prompt, ...lines);
  };
  const commandNotice = (text: string) => {
    if (routing.current && !turn.current && !shellCall.current) transcript.addCommand(routing.current, safeText(text));
    else notices.addNotice(text);
  };
  const host: CommandHost = {
    client,
    busy: () => !!turn.current || (!!controls.current && composer.busy),
    open,
    notice: commandNotice,
    reset,
    submit,
    exit: () => gate.exit(),
  };
  const command = async (raw: string) => {
    if (!ready || closing.current) return;
    const abort = new AbortController();
    routing.current = raw.trim();
    const task = routeCommand({...host, signal: abort.signal}, raw);
    // /exit starts shutdown synchronously: do not make shutdown await itself.
    if (closing.current) return;
    commands.current.set(abort, task);
    try {
      await task;
    } finally {
      commands.current.delete(abort);
      if (routing.current === raw.trim()) routing.current = undefined;
    }
  };
  current.current = {shutdown, command};
  const composer = useComposer({
    onSubmit: submit,
    onCommand: command,
    busy,
    workspaceAccess: ready,
    isActive: ready && !overlay.active && !detail.detailed,
    inputWidth: Math.max(1, width - 3),
    onToggleTasks: plan.toggleTodos,
    onRewind: () => open('rewind'),
    onEditor: () => void editInExternalEditor(),
    onSuspend: suspendProcess,
    onSendQueuedNow: sendQueuedNow,
    onRedraw: () => void suspendTerminal(() => {}),
    onOpenAgents: () => open('background-tasks'),
    onOpenBackgroundTasks: () => open('background-tasks'),
    onReadClipboardImage: () => readMacClipboardImage(),
    onNotice: notices.addNotice,
    onEmptyHomeEnd: edge =>
      overlay.open(
        'history',
        <HistoryDialog
          items={transcript.items}
          initialOffset={edge === 'start' ? Math.max(0, transcript.items.length - 8) : 0}
        />,
      ),
    onRemember: async content => {
      const result = await client.writeMemory({
        name: `note-${crypto.randomUUID().slice(0, 8)}`,
        description: content.replace(/\s+/g, ' ').slice(0, 300),
        type: 'feedback',
        content,
      });
      notices.addNotice(result.content);
      return result.status === 'ok';
    },
    onShellStart: command => {
      const call = {id: `shell-${crypto.randomUUID()}`, name: 'exec_command', input: {cmd: command}};
      shellCall.current = call;
      transcript.begin(`!${command}`);
      transcript.applyEvent({type: 'toolCallComplete', call});
      return call.id;
    },
    onShellError: code => {
      if (shellCall.current) transcript.finish({error: `Shell failed [${code}].`});
      shellCall.current = null;
    },
    onShellOutput: chunk => {
      if (!shellCall.current) {
        shellCall.current = {
          id: `shell-${crypto.randomUUID()}`,
          name: 'exec_command',
          input: {cmd: composer.content.slice(1).trim()},
        };
        transcript.begin(composer.content);
        transcript.applyEvent({type: 'toolCallComplete', call: shellCall.current});
      }
      transcript.applyEvent({
        type: 'toolOutputDelta',
        callId: shellCall.current.id,
        name: 'exec_command',
        stream: chunk.stream,
        text: chunk.text,
      });
    },
    onShellResult: (result: ToolResult) => {
      const call = shellCall.current ?? {
        id: result.callId,
        name: 'exec_command',
        input: {cmd: composer.content.slice(1).trim()},
      };
      if (!shellCall.current) {
        transcript.begin(composer.content);
        transcript.applyEvent({type: 'toolCallComplete', call});
      }
      transcript.applyEvent({type: 'toolResult', result: {...result, callId: call.id}});
      transcript.finish();
      if (result.sessionId)
        notices.addNotice(
          `Shell session ${result.sessionId} is still running. Ask the agent to collect its final result with write_stdin.`,
        );
      shellCall.current = null;
      session.current = client.activeSession()?.id;
    },
  });
  controls.current = composer;
  useEffect(() => {
    if (ready && !started.current) {
      started.current = true;
      if (initialCommand) void current.current?.command(initialCommand);
    }
  }, [ready, initialCommand]);
  const status = useStatusLine(composer.content, ready);
  useEffect(() => {
    mounted.current = true;
    registerShutdown?.(() => current.current!.shutdown());
    return () => {
      mounted.current = false;
      turn.current?.abort();
      client.setUserInputAvailable(false);
    };
  }, [client, registerShutdown]);
  // Reconcile pending requests after every interaction; replacing an overlay dismisses its old SDK request.
  const [interaction, setInteraction] = useState(0);
  useClientEvents({
    interaction: () => setInteraction(n => n + 1),
    plan: () => setInteraction(n => n + 1),
    background: event => {
      if (event.parentSessionId && event.parentSessionId !== client.activeSession()?.id) return;
      if (event.type === 'task.finished' && event.task.kind === 'shell' && event.delivery) {
        const task = event.task;
        transcript.addNotification(
          `background:${client.activeSession()?.id}:${task.id}`,
          `Background command "${task.description}" ${task.status === 'done' ? 'completed' : task.status}${task.exitCode === undefined ? '' : ` (exit code ${task.exitCode})`}`,
        );
      }
    },
    // Idle parent: a queued <subagent> result becomes the next turn so the model can act on it (Codex wakes the parent).
    subagent: notice => {
      if (notice.delivery !== 'queued' || !ready || closing.current || turn.current || shellCall.current) return;
      if (client.activeSession()?.id !== notice.parentSessionId) return;
      const next = client.takeQueuedMessage();
      if (next !== undefined) submit(next);
    },
    reactive: event => {
      setInteraction(n => n + 1); // permissions resolved through the SDK elsewhere must close their dialog
      if (event.kind === 'idle' && !turn.current && !shellCall.current) {
        const id = client.activeSession()?.id;
        if (id !== session.current) reset();
      }
    },
  });
  useEffect(() => {
    if (!ready || closing.current) return;
    // Never replace a dialog whose request is still pending (replacement dismisses it = a silent deny); otherwise
    // ask oldest first (the SDK lists newest first).
    const waiting = client.listPendingPermissions();
    const permission = waiting.find(p => overlay.active?.id === `permission:${p.approvalId}`) ?? waiting.at(-1);
    const question = client.listPendingQuestions()[0];
    const proposal = client.pendingPlanApproval();
    if (permission) {
      if (overlay.active?.id === `permission:${permission.approvalId}`) return;
      overlay.open(
        `permission:${permission.approvalId}`,
        <PermissionRequestDialog
          width={width}
          request={permission}
          onDenied={reason => {
            if (!reason.trim()) return;
            const feedback = `Permission denied. User feedback: ${reason}`;
            const result = client.submitWhileBusy(feedback);
            notices.addNotice(
              result.disposition === 'rejected'
                ? 'Denial feedback was not accepted; resend after the turn.'
                : 'Denial feedback accepted.',
            );
          }}
        />,
      );
    } else if (question) {
      if (overlay.active?.id !== `question:${question.questionId}`)
        overlay.open(`question:${question.questionId}`, <QuestionRequestDialog width={width} request={question} />);
    } else if (proposal) {
      if (overlay.active?.id !== `plan:${proposal.id}`)
        overlay.open(
          `plan:${proposal.id}`,
          <PlanApprovalDialog
            width={width}
            onCancel={() => turn.current?.abort()}
            onEdit={editPlanInExternalEditor}
            editorLabel={editorName({...process.env, EDITOR: process.env.EDITOR || 'vi'})}
          />,
        );
    } else if (
      overlay.active?.id.startsWith('permission:') ||
      overlay.active?.id.startsWith('question:') ||
      overlay.active?.id.startsWith('plan:')
    )
      overlay.close();
  }, [interaction, ready, overlay.active?.id]);
  /** Esc on a panel a slash command opened leaves `❯ /cmd` and `⎿  <noun> cancelled` behind (spec 7). */
  const closeOverlay = () => {
    if (!overlay.active) return;
    const info = opened.current;
    opened.current = null;
    if (overlay.active.id.startsWith('plan:')) turn.current?.abort();
    if (info && info.id === overlay.active.id) printResult(dismissalResult(info.route, info.raw));
    overlay.close();
  };
  closePanel.current = closeOverlay;
  /** Ctrl+C / Ctrl+D inside a dialog: the first press asks, a second within 1.5 s closes the dialog. */
  const dialogExit = (label: 'Ctrl-C' | 'Ctrl-D') => {
    const now = Date.now();
    const last = dialogPress.current;
    if (last && last.key === label && now - last.at < 1500) {
      dialogPress.current = null;
      closeOverlay();
      return;
    }
    dialogPress.current = {key: label, at: now};
    notices.addNotice(`Press ${label} again to close`);
  };
  const stopWork = () => {
    if (!composer.interrupt()) {
      turn.current?.abort();
      for (const abort of commands.current.keys()) abort.abort();
    }
  };
  const dialogCancel = () => {
    if (!overlay.active) return false;
    if (ready) closeOverlay();
    else overlay.close();
  };
  const viewing = ready && detail.detailed && !overlay.active;
  // Task 6 supplies the search bar state; transcript keys yield while its query owns focus.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [keptQuery, setKeptQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState<SearchIndex | null>(null);
  const [indexMs, setIndexMs] = useState<number>();
  const [matchAt, setMatchAt] = useState(0);
  const searchRevision = useRef(transcript.items);
  useEffect(() => {
    if (!detail.detailed) {
      setSearchOpen(false);
      setLegendOpen(false);
      setViewerStatus(undefined);
      setQuery('');
      setKeptQuery('');
    }
  }, [detail.detailed]);
  useEffect(() => {
    if (searchRevision.current !== transcript.items) {
      searchRevision.current = transcript.items;
      setSearchIndex(null);
    }
    if (!detail.detailed || (!searchOpen && !query)) return;
    if (searchIndex && searchRevision.current === transcript.items) return;
    const abort = new AbortController();
    const start = performance.now();
    void buildSearchIndexAsync(transcript.items, abort.signal).then(index => {
      if (!index || abort.signal.aborted) return;
      setSearchIndex(index);
      const ms = Math.round(performance.now() - start);
      setIndexMs(ms >= 20 ? ms : undefined);
    });
    return () => abort.abort();
  }, [transcript.items, detail.detailed, searchOpen, !!query, searchIndex]);
  useEffect(() => {
    if (indexMs === undefined) return;
    const timer = setTimeout(() => setIndexMs(undefined), 2000);
    return () => clearTimeout(timer);
  }, [indexMs]);
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  useEffect(() => {
    const abort = new AbortController();
    setMatches([]);
    if (searchIndex)
      void findMatchesAsync(searchIndex, query, abort.signal).then(found => {
        if (found && !abort.signal.aborted) setMatches(found);
      });
    return () => abort.abort();
  }, [searchIndex, query]);
  const currentMatch = matches[matchAt % Math.max(1, matches.length)];
  const currentItem = currentMatch ? transcript.items[currentMatch.itemIndex] : undefined;
  const matchBadge = matches.length ? `${(matchAt % matches.length) + 1} of ${matches.length}` : undefined;
  const searchAnchors = useRef(new Map<string, DOMElement>());
  useEffect(() => {
    if (!currentMatch || !currentItem || !detail.detailed) return;
    const timer = setImmediate(() => {
      const element = searchAnchors.current.get(currentItem.id);
      const root = scroll.content.current;
      if (element && root)
        scroll.showRow(
          rowWithin(element, root) +
            renderToString(
              <Box width={contentWidth}>
                <Text>{(searchIndex?.[currentMatch.itemIndex] ?? '').slice(0, currentMatch.end)}</Text>
              </Box>,
            ).split('\n').length -
            1,
        );
    });
    return () => clearImmediate(timer);
  }, [currentMatch, currentItem, detail.detailed, olderPages]);
  const cycleMatch = (delta: number) => {
    if (!transcriptKeysActive) return false;
    if (matches.length) setMatchAt(at => (at + delta + matches.length) % matches.length);
  };
  const transcriptKeysActive = viewing && !searchOpen;
  const scrolling = fullscreen && ready && !overlay.active && !searchOpen;
  useKeybindings({
    Global: {
      'app:interrupt': () => {
        if (!ready) {
          if (overlay.active) overlay.close();
          else gate.exit();
          return;
        }
        if (overlay.active) return dialogExit('Ctrl-C');
        if (detail.detailed) return detail.setDetailed(false);
        // Running work is interrupted like Esc; only an idle prompt arms the exit.
        if (turn.current || shellCall.current || composer.busy || commands.current.size) return stopWork();
        if (composer.confirmExit()) gate.exit();
      },
      'app:exit': () => {
        if (!ready) return gate.exit();
        if (overlay.active) return dialogExit('Ctrl-D');
        if (detail.detailed) return;
        if (composer.pressEof()) gate.exit();
      },
      'app:toggleTranscript': () => {
        if (composer.shortcuts) {
          composer.interrupt();
          return;
        }
        if (ready) {
          if (!detail.detailed) setShowAll(false);
          detail.toggleDetailed();
        }
      },
    },
    Chat: {
      'chat:cancel': () => {
        if (!ready) {
          if (overlay.active) overlay.close();
          else gate.exit();
        } else if (overlay.active) closeOverlay();
        else if (detail.detailed) detail.setDetailed(false);
        else stopWork();
      },
      'chat:cycleMode': () => {
        if (composer.shortcuts) {
          composer.interrupt();
          return;
        }
        if (ready && !overlay.active && !composer.busy) permissions.cycleMode();
      },
    },
    // Dialogs that do not bind their own cancel key fall back to the shell (it prints the `cancelled` result).
    Select: {'select:cancel': () => dialogCancel()},
    Confirmation: {'confirm:no': () => dialogCancel()},
    Settings: {'settings:close': () => dialogCancel()},
    Help: {'help:dismiss': () => dialogCancel()},
    EffortSlider: {'effort:cancel': () => dialogCancel()},
    MessageSelector: {'rewind:cancel': () => dialogCancel()},
    DiffDialog: {'diff:back': () => dialogCancel()},
    Scroll: {
      'scroll:pageUp': () => (scrolling ? scroll.pageUp() : false),
      'scroll:pageDown': () => (scrolling ? scroll.pageDown() : false),
      'scroll:top': () => (scrolling ? scroll.toTop() : false),
      'scroll:bottom': () => (scrolling ? scroll.toBottom() : false),
      'scroll:lineUp': () => (transcriptKeysActive ? scroll.scrollBy(1) : false),
      'scroll:lineDown': () => (transcriptKeysActive ? scroll.scrollBy(-1) : false),
    },
    Transcript: {
      'transcript:search': () => {
        if (!transcriptKeysActive) return false;
        setSearchOpen(true);
        setLegendOpen(false);
      },
      'transcript:nextMatch': () => cycleMatch(1),
      'transcript:previousMatch': () => cycleMatch(-1),
      'transcript:toggleShowAll': () =>
        transcriptKeysActive && !virtualScrollActive ? setShowAll(value => !value) : false,
      'scroll:lineUp': () => (transcriptKeysActive ? scroll.scrollBy(1) : false),
      'scroll:lineDown': () => (transcriptKeysActive ? scroll.scrollBy(-1) : false),
      'scroll:halfPageUp': () => (transcriptKeysActive ? scroll.halfPageUp() : false),
      'scroll:halfPageDown': () => (transcriptKeysActive ? scroll.halfPageDown() : false),
      'scroll:fullPageUp': () => (transcriptKeysActive ? scroll.scrollBy(Math.max(1, scroll.viewRows)) : false),
      'scroll:fullPageDown': () => (transcriptKeysActive ? scroll.scrollBy(-Math.max(1, scroll.viewRows)) : false),
      'scroll:top': () => (transcriptKeysActive ? scroll.toTop() : false),
      'scroll:bottom': () => (transcriptKeysActive ? scroll.toBottom() : false),
      'transcript:exit': () => (transcriptKeysActive ? detail.setDetailed(false) : false),
      'transcript:previousPrompt': () => (transcriptKeysActive ? jumpPrompt(-1) : false),
      'transcript:nextPrompt': () => (transcriptKeysActive ? jumpPrompt(1) : false),
      'transcript:dumpScrollback': () => (transcriptKeysActive ? void dumpScrollback() : false),
      'transcript:openEditor': () => (transcriptKeysActive ? void openTranscriptInEditor() : false),
      'transcript:help': () => (transcriptKeysActive ? setLegendOpen(value => !value) : false),
    },
  });
  // The shared router reports chord problems in the composer footer and runs `command:<name>` bindings.
  useEffect(() => {
    router?.configure({
      onNotice: message => composer.flash(message, 1500),
      onCommand: name => {
        if (!ready || overlay.active || closing.current) return false;
        void current.current?.command(`/${name}`);
      },
    });
  });
  useEffect(() => {
    if (overlay.active) router?.reset();
  }, [overlay.active?.id]);
  // keybindings.json problems: shown once per distinct set of warnings (the watcher also logs them).
  useEffect(() => {
    let shown = '';
    const show = () => {
      const warnings = keymapStore.get().warnings;
      const key = warnings.join('\n');
      if (key === shown) return;
      shown = key;
      if (warnings.length)
        notices.addNotice(
          `Keybindings: ${warnings[0]}${warnings.length > 1 ? ` (+${warnings.length - 1} more, see ~/.cosmew/debug/keybindings.log)` : ''} Defaults stay in effect for those keys.`,
        );
    };
    show();
    return keymapStore.subscribe(show);
  }, []);
  const activity = transcript.items.findLast(item => item.streaming);
  // The tail window keeps frame cost bounded in long sessions; paging to the top pulls older items in.
  const windowSize = 60 + olderPages * 40;
  const matchWindowStart = currentMatch ? Math.max(0, currentMatch.itemIndex - 30) : undefined;
  const shownItems = fullscreen
    ? matchWindowStart !== undefined
      ? transcript.items.slice(matchWindowStart, matchWindowStart + 60)
      : transcript.items.slice(-windowSize)
    : transcript.items;
  const showBanner = ready && shownItems.length === transcript.items.length;
  const tip = spinnerTip(transcript.items.filter(item => item.role === 'user').length);
  const warning = composer.status.permissionMode === 'bypassPermissions' ? BYPASS_PERMISSIONS_WARNING : undefined;
  const dialogWaiting = !!client.listPendingPermissions().length || !!client.listPendingQuestions().length;
  // A dialog replaces the composer; the transcript clips first so choices never leave the screen.
  const dialogRows = screenRows ? Math.max(1, screenRows - 1 - (ready && detail.detailed ? 2 : 0)) : undefined;
  const body = (
    <>
      {!ready ? (
        <Box display={overlay.active ? 'none' : 'flex'} marginTop={fullscreen ? 1 : 0}>
          <StartupGate state={gate} width={width} />
        </Box>
      ) : (
        <>
          {showBanner ? (
            <Box marginTop={fullscreen ? 1 : 0} flexDirection="column">
              <Welcome status={status.status} width={contentWidth} />
            </Box>
          ) : null}
          <PromptAnchors.Provider value={anchors.current}>
            <SearchAnchors.Provider value={searchAnchors.current}>
              <Transcript
                items={shownItems}
                bounded
                showSpinner={false}
                width={contentWidth}
                liveRows={Math.max(1, (screenRows ?? 24) - 6)}
                detailed={detail.detailed}
                showAll={showAll || !!currentMatch}
                searchMatch={
                  currentItem && currentMatch
                    ? {id: currentItem.id, ...currentMatch, text: searchIndex?.[currentMatch.itemIndex] ?? ''}
                    : undefined
                }
                virtualScroll={virtualScrollActive}
                model={status.status.selection?.modelId}
              />
            </SearchAnchors.Provider>
          </PromptAnchors.Provider>
          <Subagents agents={agents.agents} width={contentWidth} />
          <Notices notices={notices.notices} width={contentWidth} />
        </>
      )}
    </>
  );
  return (
    <Box
      flexDirection="column"
      width={width}
      minWidth={0}
      height={screenRows}
      overflow={fullscreen ? 'hidden' : undefined}
    >
      <InputScope active={!overlay.active}>
        <Box flexDirection="row" flexGrow={fullscreen ? 1 : 0} flexShrink={1} minHeight={1} overflow="hidden">
          <Box width={contentWidth} minWidth={0} flexDirection="column" flexGrow={1} flexShrink={1}>
            {fullscreen && ready ? (
              <ScrollViewport scroll={scroll}>{body}</ScrollViewport>
            ) : (
              <Box flexDirection="column" flexGrow={fullscreen ? 1 : 0}>
                {body}
              </Box>
            )}
          </Box>
          {ready && diffLayout.visible && !overlay.active ? (
            <DiffSidePanel
              report={diff.report}
              onChangeBase={base => {
                void diff.refresh(base);
              }}
              width={diffLayout.panelWidth}
              height={Math.max(1, (screenRows ?? 30) - 6)}
              isActive={!overlay.active && !detail.detailed}
              onClose={() => {
                setDiffOpen(false);
              }}
              onNotice={notices.addNotice}
            />
          ) : null}
        </Box>
        {ready ? (
          <Box flexDirection="column" flexShrink={0} display={overlay.active || detail.detailed ? 'none' : 'flex'}>
            <ComposerView
              controller={composer}
              width={width}
              maxRows={screenRows && screenRows < 16 ? 1 : 6}
              showHints={!screenRows || screenRows >= 12}
              fullscreen={fullscreen}
              warning={warning}
              activity={
                activity ? (
                  <Box flexDirection="column">
                    <Spinner
                      key={activity.id}
                      startedAt={activity.startedAt}
                      tokens={activity.usage?.outputTokens ?? undefined}
                      effort={composer.status.reasoningEffort ?? undefined}
                      thinking={isThinking(activity)}
                      tip={tip}
                      width={width}
                    />
                    {busy && plan.todosVisible ? <Plan plan={plan.plan} width={width} /> : null}
                  </Box>
                ) : busy && plan.todosVisible ? (
                  <Plan plan={plan.plan} width={width} />
                ) : undefined
              }
            />
          </Box>
        ) : null}
      </InputScope>
      {ready && detail.detailed && !overlay.active && searchOpen ? (
        <SearchBar
          width={width}
          query={query}
          onChange={value => {
            setQuery(value);
            setMatchAt(0);
          }}
          count={matches.length}
          badge={searchStatus({
            building: !searchIndex,
            ms: indexMs,
            query,
            count: matches.length,
            current: matchAt + 1,
          })}
          onClose={keep => {
            setSearchOpen(false);
            const value = keep && matches.length ? query : keptQuery;
            setQuery(value);
            if (keep) setKeptQuery(value);
            setMatchAt(0);
          }}
        />
      ) : ready && detail.detailed && !overlay.active && legendOpen ? (
        <TranscriptLegend width={width} editorName={transcriptEditorName} />
      ) : ready && detail.detailed ? (
        <DetailedFooter
          rightStatus={viewerStatus}
          searchActive={!!matchBadge}
          badge={matchBadge}
          width={width}
          showingAll={showAll}
          // Use B2's scroll/help variant when the recent window has nothing to hide.
          virtualScroll={virtualScrollActive || transcript.items.length <= DETAILED_RECENT_LIMIT}
          suppressShowAll={transcript.items.length <= DETAILED_RECENT_LIMIT}
          status={dialogWaiting ? 'dialog waiting' : busy || composer.busy ? 'working' : undefined}
          editorName={
            (process.env.VISUAL || process.env.EDITOR || '').trim().split(/\s+/)[0]?.split('/').pop() || undefined
          }
        />
      ) : null}
      {overlay.active ? (
        <Box flexDirection="column" flexShrink={0}>
          <LiveDialog rows={dialogRows}>{overlay.active.content}</LiveDialog>
        </Box>
      ) : null}
    </Box>
  );
}
