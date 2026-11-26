import {SandboxDialog} from './features/sandbox';
/** @jsxImportSource react */
import {useTerminalSize} from './hooks/use-terminal-size';
import {useTerminalMouseCapture, useTerminalSelectionCopied, useTerminalWheel} from './hooks/use-terminal-wheel';
import {useCallback, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Box, Text, renderToString, useApp, useStdout, type DOMElement} from 'ink';
import {
  BYPASS_PERMISSIONS_WARNING,
  FutrynError,
  type SkillVisibility,
  type ToolCall,
  type ToolResult,
} from '@cosmew/contracts';
import {parseMemoryCitations} from '@cosmew/sdk';
import {useOverlay} from './core';
import {
  InputScope,
  ensureKeybindingsFile,
  keybindingsPath,
  keymapStore,
  loadKeybindings,
  useBindingLabel,
  useClientEvents,
  useFutrynClient,
  useKeyRouter,
  useKeybindings,
  useTextInput,
} from './hooks';
import {useTheme} from './theme';
import {Panel, TextLine, safeText, spinnerTip} from './ui';
import {copyToClipboard, readMacClipboardImage} from '../clipboard';
import {Welcome} from './features/welcome';
import {StartupGate, useStartupGate} from './features/startup-gate';
import {verificationMessage} from './features/startup-gate/logic';
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
  searchExcerpt,
  type SearchIndex,
  type SearchMatch,
} from './features/transcript/search';
import {ActivityNavigation, type ActivityAnchor} from './features/transcript/activity';
import {useTranscriptViewport} from './features/transcript/viewport';
import {TranscriptLegend} from './features/transcript/legend';
import {SearchBar} from './features/transcript/search-bar';
import {DetailedFooter} from './features/transcript/detailed-footer';
import {DETAILED_RECENT_LIMIT} from './features/transcript/show-all';
import {ComposerView, useComposer, editorName} from './features/composer';
import {Plan, usePlan} from './features/plan';
import {Notices, useNotices} from './features/notices';
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
import {TaskNotifications} from './features/background-tasks/notifications';
import {PlanApprovalDialog} from './features/plan-approval';
import {PickerDialog} from './features/picker';
import {routeCommand, type CommandChoice, type CommandHost} from './features/commands';
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
function CommandChoiceDialog({
  title,
  choices,
  writeKey,
  width,
  finish,
}: {
  title: string;
  choices: readonly CommandChoice[];
  writeKey?: boolean;
  width: number;
  finish(selection?: {id: string; write: boolean}): void;
}) {
  const highlighted = useRef(choices[0]?.id);
  useEffect(() => () => finish(), [finish]);
  return (
    <PickerDialog
      title={title}
      items={choices}
      width={width}
      message={writeKey ? 'Enter to copy · w to save to a file' : undefined}
      onHighlight={item => {
        highlighted.current = item.id;
      }}
      onSelect={item => finish({id: item.id, write: false})}
      onTextKey={
        writeKey
          ? key => {
              if (key !== 'w' || !highlighted.current) return false;
              finish({id: highlighted.current, write: true});
              return true;
            }
          : undefined
      }
    />
  );
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
  const {showTurnDuration} = useFutrynClient().userPreferences();
  const [offset, setOffset] = useState(initialOffset);
  useTextInput((_input, key) => {
    if (key.pageUp || key.home)
      setOffset(n => (key.home ? Math.max(0, items.length - 8) : Math.min(Math.max(0, items.length - 8), n + 8)));
    if (key.pageDown || key.end) setOffset(n => (key.end ? 0 : Math.max(0, n - 8)));
  });
  return (
    <Panel title="Transcript history" width={width}>
      <Transcript
        items={items}
        historyOffset={offset}
        liveItems={8}
        isActive
        animate={false}
        showTurnDuration={showTurnDuration}
      />
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
        ? 'The selected model or request setting is unsupported. Check /model and /effort; tool access was not changed.'
        : error.code === 'INVALID_INPUT'
          ? 'The request was rejected as invalid. Check /effort, /model or /doctor. Tool access was not changed.'
          : error.code === 'CONTEXT_LIMIT'
            ? 'The request exceeded the model context window. Use /compact before continuing.'
            : error.code === 'TIMEOUT'
              ? 'The provider request timed out.'
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
  const {exit, suspendTerminal, waitUntilRenderFlush} = useApp();
  const {stdout} = useStdout();
  const router = useKeyRouter();
  const anchors = useRef(new Map<string, DOMElement>());
  const dialogPress = useRef<{key: string; at: number} | null>(null);
  const {engine, color} = useTheme();
  const theme = engine.getActiveAppearance().theme;
  const canvasColor = theme === 'midnight' || theme === 'parchment' ? color('background') : undefined;
  const {columns} = useTerminalSize();
  const screenRows = useLiveRows(requestedRows);
  const fullscreen = screenRows !== undefined;
  const width = Math.max(1, requestedWidth ?? columns);
  const transcript = useTranscript();
  const {verbose, showTurnDuration} = client.userPreferences();
  const detail = useDetailedTranscript(verbose);
  const {setDetailed} = detail;
  useEffect(() => setDetailed(verbose), [setDetailed, verbose]);
  const activityAnchors = useRef(new Map<string, ActivityAnchor>());
  const [focusedActivity, setFocusedActivity] = useState<string>();
  const [expandedByItem, setExpandedByItem] = useState(new Map<string, ReadonlySet<string>>());
  const revealOnToggle = useRef<string | undefined>(undefined);
  const toggleActivity = useCallback((itemId: string, id: string) => {
    revealOnToggle.current = id;
    setExpandedByItem(previous => {
      const next = new Map(previous);
      const expanded = new Set(next.get(itemId));
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      if (expanded.size) next.set(itemId, expanded);
      else next.delete(itemId);
      return next;
    });
  }, []);
  const verboseKey = useBindingLabel('Global', 'app:toggleTranscript');
  const selectionKey = useBindingLabel('Global', 'app:toggleTextSelection');
  const [textSelection, setTextSelection] = useState(false);
  useTerminalMouseCapture(!textSelection);
  const previousActivityKey = useBindingLabel('Transcript', 'transcript:focusPrevious');
  const nextActivityKey = useBindingLabel('Transcript', 'transcript:focusNext');
  const toggleActivityKey = useBindingLabel('Transcript', 'transcript:toggleItem');
  const activityNavigation = useMemo(
    () => ({
      anchors: activityAnchors.current,
      toggle: toggleActivity,
      expandHint: verboseKey === 'unbound' ? '(click to expand)' : `(click or ${verboseKey} to expand)`,
    }),
    [toggleActivity, verboseKey],
  );
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
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffFocused, setDiffFocused] = useState(false);
  const diff = useDiff(diffOpen);
  const diffLayout = diffPanelLayout(width, diffOpen);
  const contentWidth = diffLayout.mainWidth;
  const diffHasFocus = diffFocused && diffLayout.visible && !overlay.active && !detail.detailed;
  useEffect(() => {
    if (!diffOpen || !diffLayout.visible) setDiffFocused(false);
  }, [diffOpen, diffLayout.visible]);
  const autoDiffOpened = useRef(false);
  const notices = useNotices(16, {subscribeSubagents: false});
  const taskNotifications = useRef(new TaskNotifications());
  const plan = usePlan();
  const permissions = usePermissions();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checkingAccount, setCheckingAccount] = useState(false);
  const scroll = useScrollback();
  useTerminalWheel(
    event => {
      if (diffLayout.visible && event.column > contentWidth) return;
      scroll.scrollBy(-event.direction * 3);
    },
    fullscreen && ready && !overlay.active && !diffHasFocus,
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
  const commands = useRef(new Map<AbortController, Promise<boolean | void>>());
  const mounted = useRef(true);
  const started = useRef(false);
  const [initialSessionId] = useState(() => client.status().activeSessionId ?? undefined);
  const session = useRef(initialSessionId);
  const shellCall = useRef<ToolCall | null>(null);
  const controls = useRef<{interrupt(): boolean; shutdown(): Promise<void>} | null>(null);
  const current = useRef<{shutdown(): Promise<void>; command(raw: string): Promise<boolean | void>} | null>(null);
  const reset = () => {
    transcript.reset();
    taskNotifications.current.reset(client.status().activeSessionId ?? undefined);
    setExpandedByItem(new Map());
    setFocusedActivity(undefined);
    revealOnToggle.current = undefined;
    setDiffOpen(false);
    autoDiffOpened.current = false;
    session.current = client.status().activeSessionId ?? undefined;
    scroll.toBottom();
    notices.clearNotices();
  };
  const requestExit = () => {
    if (closing.current) return;
    closing.current = true;
    void current.current?.shutdown().finally(() => exit());
  };
  const pendingSkillOverrides = useRef<Record<string, SkillVisibility>>({});
  const open = (route: string, args?: string) => {
    if (closing.current) return;
    if (!ready && route !== 'connect' && route !== 'models') return;
    const changed = () => {
      if ((client.status().activeSessionId ?? undefined) !== session.current) reset();
    };
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
            onNavigate={action => {
              if (action === 'editor-mode') {
                client.setEditorMode(client.editorMode() === 'vim' ? 'normal' : 'vim');
              } else open(action);
            }}
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
      case 'sandbox':
        show('sandbox', <SandboxDialog width={width} />);
        break;
      case 'permissions':
        show('permissions', <PermissionRulesDialog width={width} />);
        break;
      case 'background-tasks':
        show(route, <BackgroundTasksDialog width={width} initialTaskId={args} />);
        break;
      case 'agents':
        show(route, <AgentsDialog width={width} />);
        break;
      case 'memory':
        show(route, <MemoryDialog width={width} />);
        break;
      case 'skills':
        pendingSkillOverrides.current = {};
        show(route, <SkillsDialog width={width} onChange={changes => (pendingSkillOverrides.current = changes)} />);
        break;
      case 'context':
        // Claude Code prints the grid into the transcript; mid-turn it would land inside the running answer.
        if (!turn.current && !shellCall.current) {
          scroll.toBottom();
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
    await pending.current;
    await controls.current?.shutdown();
    await Promise.allSettled(commands.current.values());
    await Promise.allSettled(overlay.tasks.values());
    client.setToolsEnabled(false);
    if (engine.isPreviewing()) engine.cancelPreview();
  };
  const submit = async (text: string, label?: string): Promise<boolean> => {
    if (!ready || closing.current || turn.current || !client.toolsEnabled()) return false;
    const abort = new AbortController();
    turn.current = abort;
    scroll.toBottom();
    setCheckingAccount(true);
    const verification = client.verifyAccount(abort.signal);
    pending.current = verification.then(
      () => {},
      () => {},
    );
    try {
      const result = await verification;
      if (closing.current || abort.signal.aborted || !mounted.current) return false;
      if (!result.ok) {
        notices.addNotice(
          result.reason === 'billing'
            ? verificationMessage(result.reason, status.activeAccount?.alias, result.providerHint)
            : verificationMessage(result.reason),
        );
        open(result.reason === 'no-account' ? 'connect' : 'accounts');
        return false;
      }
    } finally {
      turn.current = null;
      if (mounted.current) setCheckingAccount(false);
    }
    turn.current = abort;
    setBusy(true);
    pending.current = (async () => {
      let prompt: string | undefined = text;
      while (
        prompt !== undefined &&
        (prompt.trim() || client.imageAttachments().length) &&
        !closing.current &&
        !abort.signal.aborted
      ) {
        const displayPrompt = [label ?? prompt, ...client.imageAttachments().map(image => image.label)]
          .filter(Boolean)
          .join('\n');
        label = undefined;
        transcript.begin(displayPrompt, undefined, status.selection?.modelId);
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
            abort.signal.aborted || sendNow.current || (error instanceof FutrynError && error.code === 'CANCELLED')
              ? {cancelled: true}
              : {error: requestFailure(error)},
          );
        }
        session.current = client.status().activeSessionId ?? undefined;
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
    const tops = transcript.items.flatMap((item, index) => {
      if (item.role !== 'user') return [];
      const node = anchors.current.get(item.id);
      const row = node ? rowWithin(node, content) : window.offsets[index];
      return row === undefined ? [] : [row];
    });
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
    setTheme: id => engine.setTheme(id),
    exportTranscript: () => safeText(parseMemoryCitations(transcriptPlainText(transcript.items)).content),
    responseText: index => {
      for (let i = transcript.items.length - 1; i >= 0; i--) {
        const item = transcript.items[i]!;
        if (item.role !== 'assistant' || item.streaming || item.interrupted || item.errorText || !item.parts?.length)
          continue;
        const text = safeText(parseMemoryCitations(item.content).content).trim();
        if (text && --index === 0) return text;
      }
    },
    copyText: async text => {
      if (!text || !('isTTY' in stdout && stdout.isTTY)) return false;
      return copyToClipboard(text, {terminal: sequence => stdout.write(sequence)});
    },
    exit: () => gate.exit(),
  };
  const command = async (raw: string) => {
    if (!ready || closing.current) return;
    const abort = new AbortController();
    routing.current = raw.trim();
    let commandId: string | undefined;
    let commandSessionId: string | undefined;
    const lines: string[] = [];
    const task = routeCommand(
      {
        ...host,
        signal: abort.signal,
        choose: (title, choices, writeKey) =>
          new Promise(resolve => {
            const cancel = () => resolve(undefined);
            abort.signal.addEventListener('abort', cancel, {once: true});
            overlay.open(
              'command-choice',
              <CommandChoiceDialog
                title={title}
                choices={choices}
                writeKey={writeKey}
                width={width}
                finish={selection => {
                  abort.signal.removeEventListener('abort', cancel);
                  resolve(selection);
                  if (selection) overlay.close();
                }}
              />,
            );
          }),
        beforeWork: async () => {
          if (turn.current || shellCall.current) return;
          commandSessionId = client.activeSession()?.id;
          commandId = transcript.beginCommand(safeText(raw.trim()));
          scroll.toBottom();
          if ('isTTY' in stdout && stdout.isTTY) await waitUntilRenderFlush();
          else await new Promise<void>(resolve => setImmediate(resolve));
          abort.signal.throwIfAborted();
        },
        notice: text => {
          if (commandId) lines.push(safeText(text));
          else commandNotice(text);
        },
      },
      raw,
    );
    // /exit starts shutdown synchronously: do not make shutdown await itself.
    if (closing.current) return;
    commands.current.set(abort, task);
    try {
      return await task;
    } finally {
      commands.current.delete(abort);
      if (commandId && mounted.current) {
        if (client.activeSession()?.id !== commandSessionId) {
          // The old pending row was cleared with its session. Publish only a fixed cancellation
          // notice here; never replay that session's command output into the newly selected one.
          if (abort.signal.aborted || lines.includes('Review cancelled: conversation changed.'))
            notices.addNotice('Command cancelled: conversation changed.');
        } else transcript.finishCommand(commandId, abort.signal.aborted ? ['Command cancelled.'] : lines);
      }
      if (routing.current === raw.trim()) routing.current = undefined;
    }
  };
  current.current = {shutdown, command};
  const hasActivities = useMemo(
    () => transcript.items.some(item => item.toolCalls?.length || item.parts?.some(part => part.kind === 'reasoning')),
    [transcript.items],
  );
  const composer = useComposer({
    transcriptItems: hasActivities,
    onSubmit: submit,
    onCommand: command,
    busy,
    workspaceAccess: ready,
    isActive: ready && !overlay.active && !detail.detailed && !diffHasFocus,
    inputWidth: Math.max(1, width - 3),
    onToggleTasks: plan.toggleTodos,
    onRewind: () => open('rewind'),
    onEditor: () => void editInExternalEditor(),
    onSuspend: suspendProcess,
    onSendQueuedNow: sendQueuedNow,
    onRedraw: () => void suspendTerminal(() => {}),
    onOpenAgents: id => open('background-tasks', id),
    onOpenBackgroundTasks: id => open('background-tasks', id),
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
      session.current = client.status().activeSessionId ?? undefined;
    },
  });
  controls.current = composer;
  useTerminalSelectionCopied(text => {
    const lineCount = text.split('\n').length;
    if (detail.detailed) {
      setViewerStatus(lineCount > 1 ? `copied ${lineCount} lines` : 'copied to clipboard');
    } else {
      composer.flash(lineCount > 1 ? `Copied ${lineCount} lines to clipboard` : 'Copied to clipboard', 2000);
    }
  }, ready);
  useEffect(() => {
    if (ready && !started.current) {
      started.current = true;
      if (initialCommand) void current.current?.command(initialCommand);
    }
  }, [ready, initialCommand]);
  const status = composer.status;
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
      const notice = taskNotifications.current.background(client.status().activeSessionId ?? undefined, event);
      if (notice) transcript.addNotification(notice.id, notice.text);
    },
    // Idle parent: a queued <subagent> result becomes the next turn so the model can act on it (Codex wakes the parent).
    subagent: notice => {
      const notification = taskNotifications.current.subagent(client.status().activeSessionId ?? undefined, notice);
      if (notification) transcript.addNotification(notification.id, notification.text);
      if (notice.delivery !== 'queued' || !ready || closing.current || turn.current || shellCall.current) return;
      if ((client.status().activeSessionId ?? undefined) !== notice.parentSessionId) return;
      const next = client.takeQueuedMessage();
      if (next !== undefined) submit(next);
    },
    reactive: event => {
      setInteraction(n => n + 1); // permissions resolved through the SDK elsewhere must close their dialog
      if (event.kind === 'idle' && !turn.current && !shellCall.current) {
        const id = client.status().activeSessionId ?? undefined;
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
    if (overlay.active.id === 'skills' && Object.keys(pendingSkillOverrides.current).length) {
      try {
        client.saveSkillOverrides(pendingSkillOverrides.current);
        pendingSkillOverrides.current = {};
      } catch {
        notices.addNotice('Could not save skill visibility.');
        return;
      }
    }
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
    if (turn.current && !busy) {
      turn.current.abort();
      return;
    }
    if (!turn.current && !shellCall.current && commands.current.size) {
      for (const abort of commands.current.keys()) abort.abort();
      return;
    }
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
  // The agents conversation owns Select cancel for returning to the child
  // menu. Other dialog contexts rank above Select, even on its overlay.
  const otherDialogCancel = () =>
    overlay.active?.fullScreen || overlay.active?.id === 'agents' ? false : dialogCancel();
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
  const highlight = useMemo(
    () =>
      detail.detailed && currentItem && currentMatch
        ? {
            id: currentItem.id,
            ...searchExcerpt(searchIndex?.[currentMatch.itemIndex] ?? '', currentMatch, contentWidth),
          }
        : undefined,
    [detail.detailed, currentItem, currentMatch, searchIndex, contentWidth],
  );
  const window = useTranscriptViewport(
    transcript.items,
    contentWidth,
    detail.detailed,
    screenRows === undefined ? undefined : scroll.viewRows || screenRows,
    scroll.back,
    searchAnchors.current,
    highlight?.id,
    showTurnDuration,
  );
  const revealedMatch = useRef<typeof highlight>(undefined);
  useEffect(() => {
    if (!highlight || !fullscreen) {
      revealedMatch.current = undefined;
      return;
    }
    if (revealedMatch.current === highlight) return;
    const timer = setImmediate(() => {
      const element = searchAnchors.current.get(highlight.id);
      const root = scroll.content.current;
      if (element && root) {
        revealedMatch.current = highlight;
        scroll.showRow(
          rowWithin(element, root) +
            renderToString(
              <Box width={contentWidth}>
                <Text>{highlight.text.slice(0, highlight.end)}</Text>
              </Box>,
            ).split('\n').length -
            1,
        );
      } else if (window.enabled) {
        scroll.showRow(window.offsets[highlight.itemIndex] ?? 0);
      }
    });
    return () => clearImmediate(timer);
  }, [highlight, fullscreen, window.shown.includes(currentItem!), contentWidth, scroll.maxBack]);
  const cycleMatch = (delta: number) => {
    if (!transcriptKeysActive) return false;
    if (matches.length) setMatchAt(at => (at + delta + matches.length) % matches.length);
  };
  const transcriptKeysActive = viewing && !searchOpen;
  const scrolling = fullscreen && ready && !overlay.active && !searchOpen && !diffHasFocus;
  const activityKeys =
    ready &&
    !overlay.active &&
    !searchOpen &&
    !diffHasFocus &&
    (detail.detailed || (!composer.content && !composer.shortcuts && !composer.search));
  const revealActivity = (id: string) => {
    const row = activityAnchors.current.get(id)?.node;
    const root = scroll.content.current;
    if (!row || !root) return;
    const top = rowWithin(row, root);
    const bottom = top + (row.yogaNode?.getComputedHeight() ?? 1);
    if (top < scroll.topRow) scroll.showRow(top);
    else if (bottom > scroll.topRow + scroll.viewRows) scroll.showRow(Math.max(top - scroll.viewRows + 2, 0));
  };
  useEffect(() => {
    if (!revealOnToggle.current) return;
    const timer = setImmediate(() => {
      const id = revealOnToggle.current;
      revealOnToggle.current = undefined;
      if (id) revealActivity(id);
    });
    return () => clearImmediate(timer);
  }, [expandedByItem, scroll.maxBack]);
  const focusActivity = (delta: -1 | 1) => {
    if (!activityKeys) return false;
    const root = scroll.content.current;
    const order = [...activityAnchors.current]
      .map(([id, {node}]) => ({
        id,
        row: root ? rowWithin(node, root) : 0,
      }))
      .sort((a, b) => a.row - b.row);
    if (!order.length) return false;
    const index = order.findIndex(entry => entry.id === focusedActivity);
    const current = order[index];
    const inView = (row: number) => !root || (row >= scroll.topRow && row < scroll.topRow + scroll.viewRows);
    const target =
      current && inView(current.row)
        ? order[index + delta]
        : delta < 0
          ? order.findLast(entry => inView(entry.row))
          : order.find(entry => inView(entry.row));
    if (target) {
      setFocusedActivity(target.id);
      revealActivity(target.id);
    }
  };
  useKeybindings({
    DiffPanel: {
      'diff:blur': () => {
        if (!diffHasFocus) return false;
        setDiffFocused(false);
      },
      'diff:focus': () => {
        if (!ready || !diffLayout.visible || overlay.active || detail.detailed) return false;
        setDiffFocused(true);
      },
    },
    Global: {
      'app:toggleTextSelection': () => {
        setTextSelection(value => !value);
        if (textSelection) notices.addNotice('Mouse scrolling resumed.');
      },
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
          scroll.toBottom();
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
    Select: {'select:cancel': () => (overlay.active?.fullScreen ? false : dialogCancel())},
    Confirmation: {'confirm:no': otherDialogCancel},
    Settings: {'settings:close': otherDialogCancel},
    Help: {'help:dismiss': otherDialogCancel},
    EffortSlider: {'effort:cancel': otherDialogCancel},
    MessageSelector: {'rewind:cancel': otherDialogCancel},
    DiffDialog: {'diff:back': otherDialogCancel},
    Scroll: {
      'scroll:pageUp': () => (scrolling ? scroll.pageUp() : false),
      'scroll:pageDown': () => (scrolling ? scroll.pageDown() : false),
      'scroll:top': () => (scrolling ? scroll.toTop() : false),
      'scroll:bottom': () => (scrolling ? scroll.toBottom() : false),
      'scroll:lineUp': () => (transcriptKeysActive ? scroll.scrollBy(1) : false),
      'scroll:lineDown': () => (transcriptKeysActive ? scroll.scrollBy(-1) : false),
    },
    Transcript: {
      'transcript:focusPrevious': () => focusActivity(-1),
      'transcript:focusNext': () => focusActivity(1),
      'transcript:toggleItem': () => {
        if (!activityKeys || !focusedActivity) return false;
        const anchor = activityAnchors.current.get(focusedActivity);
        if (!anchor) return false;
        toggleActivity(anchor.itemId, focusedActivity);
      },
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
  const activity =
    busy || composer.busy || shellCall.current ? transcript.items.findLast(item => item.streaming) : undefined;
  const showBanner = ready && (!fullscreen || transcript.items.length <= 60);
  const tip = useMemo(
    () => spinnerTip(transcript.items.filter(item => item.role === 'user').length),
    [transcript.items],
  );
  const warning =
    [
      textSelection
        ? `Text selection enabled: drag to select, ${process.platform === 'darwin' ? 'Cmd+C' : 'Ctrl+Shift+C'} to copy. ${selectionKey} resumes mouse scrolling.`
        : undefined,
      composer.status.permissionMode === 'bypassPermissions' ? BYPASS_PERMISSIONS_WARNING : undefined,
      ready && composer.status.activeModel && !composer.status.toolsEnabled
        ? 'Chat only: project tools are unavailable for this model. Choose /model or refresh model metadata.'
        : undefined,
    ]
      .filter(Boolean)
      .join('\n') || undefined;
  const dialogWaiting = !!client.listPendingPermissions().length || !!client.listPendingQuestions().length;
  // A dialog replaces the composer; the transcript clips first so choices never leave the screen.
  const fullOverlay = !!overlay.active?.fullScreen;
  const dialogRows = screenRows
    ? fullOverlay
      ? Math.max(1, screenRows - (textSelection ? 1 : 0))
      : Math.max(1, screenRows - 1 - (ready && detail.detailed ? 2 : 0) - (textSelection ? 1 : 0))
    : undefined;
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
              <Welcome status={status} width={contentWidth} />
            </Box>
          ) : null}
          {window.before > 0 ? <Box height={window.before} flexShrink={0} /> : null}
          <PromptAnchors.Provider value={anchors.current}>
            <SearchAnchors.Provider value={searchAnchors.current}>
              <ActivityNavigation.Provider value={activityNavigation}>
                <Transcript
                  items={window.shown}
                  focusedId={focusedActivity}
                  expandedByItem={expandedByItem}
                  bounded
                  showSpinner={false}
                  width={contentWidth}
                  liveRows={Math.max(1, (screenRows ?? 24) - 6)}
                  detailed={detail.detailed}
                  showTurnDuration={showTurnDuration}
                  showAll={showAll || !!currentMatch}
                  searchMatch={highlight}
                  virtualScroll={virtualScrollActive}
                  model={status.selection?.modelId}
                />
              </ActivityNavigation.Provider>
            </SearchAnchors.Provider>
          </PromptAnchors.Provider>
          {window.after > 0 ? <Box height={window.after} flexShrink={0} /> : null}
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
      backgroundColor={canvasColor}
      overflow={fullscreen ? 'hidden' : undefined}
    >
      <InputScope active={!overlay.active}>
        <Box
          display={fullOverlay ? 'none' : 'flex'}
          flexDirection="row"
          flexGrow={fullscreen ? 1 : 0}
          flexShrink={1}
          minHeight={1}
          overflow="hidden"
        >
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
              focused={diffHasFocus}
              onFocus={() => setDiffFocused(true)}
              onBlur={() => setDiffFocused(false)}
              onChangeBase={base => {
                void diff.refresh(base);
              }}
              width={diffLayout.panelWidth}
              height={Math.max(1, (screenRows ?? 30) - 6)}
              isActive={!overlay.active && !detail.detailed}
              onClose={() => {
                setDiffOpen(false);
                setDiffFocused(false);
              }}
              onNotice={notices.addNotice}
            />
          ) : null}
        </Box>
        {ready ? (
          <Box flexDirection="column" flexShrink={0} display={overlay.active || detail.detailed ? 'none' : 'flex'}>
            {status.sessionTitle ? (
              <TextLine width={width} color={color('foregroundMuted')}>
                {status.sessionTitle}
              </TextLine>
            ) : null}
            <ComposerView
              controller={composer}
              width={width}
              maxRows={screenRows && screenRows < 16 ? 1 : 6}
              showHints={!screenRows || screenRows >= 12}
              fullscreen={fullscreen}
              warning={warning}
              transcriptHint={
                activityKeys && hasActivities && (focusedActivity || !scroll.atBottom)
                  ? `${previousActivityKey}/${nextActivityKey} focus · ${toggleActivityKey} toggle`
                  : undefined
              }
              activity={
                checkingAccount ? (
                  <TextLine width={width} color={color('foregroundMuted')}>
                    Checking account… · Esc to cancel
                  </TextLine>
                ) : activity ? (
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
      {ready && detail.detailed && !overlay.active && textSelection ? (
        <Box paddingLeft={Math.min(2, width)} width={width} flexShrink={0}>
          <Text color={color('info')} wrap="truncate-end">
            {`Text selection enabled: drag to select, ${process.platform === 'darwin' ? 'Cmd+C' : 'Ctrl+Shift+C'} to copy. ${selectionKey} resumes mouse scrolling.`}
          </Text>
        </Box>
      ) : null}
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
          {textSelection ? (
            <Text
              color={color('info')}
              wrap="truncate-end"
            >{`Text selection enabled · ${process.platform === 'darwin' ? 'Cmd+C' : 'Ctrl+Shift+C'} copy · ${selectionKey} return`}</Text>
          ) : null}
          <LiveDialog rows={dialogRows}>{overlay.active.content}</LiveDialog>
        </Box>
      ) : null}
    </Box>
  );
}
