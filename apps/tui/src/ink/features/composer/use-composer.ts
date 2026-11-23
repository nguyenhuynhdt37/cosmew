import type {PromptHistoryEntry, PromptHistoryScope} from '@cosmew/sdk';
import {useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore} from 'react';
import {usePaste, type Key} from 'ink';
import {FutrynError} from '@cosmew/contracts';
import {parseSlashCommand, type FutrynClient} from '@cosmew/sdk';
import {
  useClientEvents,
  useFutrynClient,
  useInputEnabled,
  useKeybindings,
  useStatus,
  VIM_COMMANDS,
  isPrintable,
  type Keystroke,
} from '../../hooks';
import {safeText} from '../../ui';
import {createVimState, reconcileVim, stepVim, vimSelection} from './vim';
import {completionContext, getCompletions, useAutocomplete, type Completion} from '../autocomplete';
import {recordHistory, useHistory} from '../history';
import {createPasteState, expandPastes, insertPaste, replaceRange, type PasteState} from '../paste';
import {footerShortcutColumns} from '../help/logic';
import {sessionTasks} from '../background-tasks/tasks';
import {
  edit,
  editSpan,
  emojiShortcode,
  insertText,
  lineEdge,
  moveCursor,
  moveTo,
  spanText,
  verticalMove,
  wordLeft,
  wordRight,
  type EditAction,
} from './logic';

export type SubmitAcceptance = void | boolean;
export interface ComposerOptions {
  /** Host checks startup gates, routes transcript, starts/owns the SDK iterator and returns at acceptance. */
  onSubmit: (content: string) => SubmitAcceptance | Promise<SubmitAcceptance>;
  onCommand?: (command: string) => SubmitAcceptance | Promise<SubmitAcceptance>;
  /** Optional until the SDK exposes a mediated memory-write API. Never writes files in the TUI. */
  onRemember?: (content: string) => SubmitAcceptance | Promise<SubmitAcceptance>;
  onShellStart?: (command: string) => string | void;
  onShellError?: (code: string) => void;
  onShellResult?: (result: Awaited<ReturnType<FutrynClient['runShellCommand']>>) => void;
  onShellOutput?: NonNullable<Parameters<FutrynClient['runShellCommand']>[1]>['onOutput'];
  onToggleTasks?: () => void;
  /** Esc Esc on an empty input: the host opens the rewind list. Without it the key reports "Not implemented". */
  onRewind?: () => void;
  /** Ctrl+G, Ctrl+Z and Ctrl+V need a host bridge; without one they report "Not implemented" and change nothing. */
  onEditor?: () => void;
  onSuspend?: () => void;
  onPasteImage?: () => void;
  onReadClipboardImage?: () => Promise<Parameters<FutrynClient['attachImage']>[0] | undefined>;
  onBackgroundTask?: () => void;
  onOpenBackgroundTasks?: (taskId?: string) => void;
  /** Ctrl+X Ctrl+S: the host transfers/interrupts the turn through SDK sendQueuedNow and drains the inbox. */
  onSendQueuedNow?: () => void;
  /** Ctrl+L: repaint the whole screen. */
  onRedraw?: () => void;
  /** Footer: Enter / ↓ on the selected agent opens the agents panel. */
  onOpenAgents?: (taskId?: string) => void;
  /** Optional extra shells owned by a legacy host; SDK backgroundTasks supplies the normal count. */
  backgroundShells?: number;
  onNotice?: (message: string) => void;
  busy?: boolean;
  isActive?: boolean;
  /** Set only after folder consent; the SDK list API does not enforce this UI gate. */
  workspaceAccess?: boolean;
  transcriptItems?: boolean;
  initialValue?: string;
  /** Override the default startup example; false disables it for custom prompts. */
  startupSuggestion?: string | false;
  initialHistory?: readonly string[];
  inputWidth?: number;
  onEmptyHomeEnd?: (edge: 'start' | 'end') => void;
}
interface SearchState {
  query: string;
  /** Position in the newest-first list of matches. */
  selected: number;
  draft: PasteState;
  scope: PromptHistoryScope;
  entries: PromptHistoryEntry[];
}
function sessionHistory(client: FutrynClient): string[] {
  return (
    client
      .activeSession()
      ?.messages.filter(message => message.role === 'user')
      .map(message => message.content) ?? []
  );
}
export function useComposer(options: ComposerOptions) {
  const client = useFutrynClient();
  const status = useStatus();
  const vimEnabled = useSyncExternalStore(
    listener => client.subscribeEditorMode(listener),
    () => client.editorMode() === 'vim',
  );
  const vim = useRef(createVimState());
  const insertUndo = useRef(false);
  const reactiveRevision = client.currentReactiveEvent();
  const [shortcuts, setShortcuts] = useState(false);
  const shortcutsRef = useRef(false);
  const dismissShortcuts = () => {
    if (!shortcutsRef.current) return false;
    shortcutsRef.current = false;
    setShortcuts(false);
    return true;
  };
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  /** Text removed by Ctrl+K/U/W/Alt+D, Ctrl+C and Esc Esc, newest first; Ctrl+Y pastes the newest, Alt+Y cycles. */
  const killRing = useRef<string[]>([]);
  const yank = useRef<{start: number; length: number; index: number} | null>(null);
  /** True while the previous command was a kill: the next kill joins the same ring entry (Emacs/readline). */
  const lastKill = useRef(false);
  /** Transient message right above the input's top rule (where the effort line sits). */
  const [slotNotice, setSlotNotice] = useState('');
  const slotTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const killAt = useRef<number | null>(null);
  const exitDAt = useRef<number | null>(null);
  const noticeTtl = useRef(2500);
  /** Selected running agent of the footer (`← 1 agent · ↓ to manage`), or null when the input has focus. */
  const [footer, setFooter] = useState<number | null>(null);
  const [deletedHint, setDeletedHint] = useState(false);
  const [selectedImage, setSelectedImage] = useState<number | null>(null);
  const attaching = useRef(false);
  const undo = useRef<PasteState[]>([]);
  const redo = useRef<PasteState[]>([]);
  const stash = useRef<PasteState | null>(null);
  const escapeAt = useRef<number | null>(null);
  const exitAt = useRef<number | null>(null);
  const [draft, setDraft] = useState(() => createPasteState(safeText(options.initialValue ?? '')));
  const draftRef = useRef(draft);
  const update = (next: PasteState) => {
    draftRef.current = next;
    setDraft(next);
  };
  useEffect(() => {
    vim.current = createVimState();
    insertUndo.current = false;
    if (draftRef.current.selectionAnchor !== undefined) update({...draftRef.current, selectionAnchor: undefined});
    rerender();
  }, [vimEnabled]);
  const [initialEntries] = useState(() => options.initialHistory ?? sessionHistory(client));
  const history = useHistory(initialEntries);
  const entriesRef = useRef(history.entries);
  entriesRef.current = history.entries;
  const navigation = useRef<{index: number; draft: PasteState} | null>(null);
  const [search, setSearch] = useState<SearchState | null>(null);
  const searchRef = useRef(search);
  searchRef.current = search;
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), noticeTtl.current);
    return () => clearTimeout(timer);
  }, [notice]);
  const [shellBusy, setShellBusy] = useState(false);
  const shellAbort = useRef<AbortController | null>(null);
  const accepting = useRef(false);
  const acceptanceSequence = useRef(0);
  const pendingInput = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  const sessionId = useRef(status.activeSessionId ?? undefined);
  const menu = useAutocomplete();
  const busy = !!options.busy || shellBusy;
  // Refresh when the request ends. Editing or scrolling does not change the context already in use.
  const contextEstimate = useMemo(() => client.context(), [client, reactiveRevision, busy]);
  useEffect(() => client.onBackgroundTaskEvent(() => rerender()), [client]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      shellAbort.current?.abort();
    };
  }, []);
  useClientEvents({
    subagent: () => rerender(),
    reactive: event => {
      if (event.kind.startsWith('subagent.')) rerender();
      // Session changes emit idle. Do not clone the full SDK session for token events.
      if (event.kind !== 'idle') return;
      const id = client.status().activeSessionId ?? undefined;
      if (id !== sessionId.current) {
        sessionId.current = id;
        // Keep the draft when moving sessions, but never navigate a stale history index.
        history.setEntries(items => sessionHistory(client).reduce((all, text) => recordHistory(all, text), items));
        navigation.current = null;
      }
    },
  });
  /** Short footer message that disappears after `ms` (the default is the usual notice time). */
  const flashSlot = (message: string, ms = 2500) => {
    clearTimeout(slotTimer.current);
    setSlotNotice(message);
    slotTimer.current = setTimeout(() => setSlotNotice(''), ms);
  };
  const flash = (message: string, ms = 2500) => {
    noticeTtl.current = ms;
    if (mounted.current) setNotice(message);
  };
  const report = (message: string) => {
    flash(message);
    options.onNotice?.(message);
  };
  const context = useMemo(() => completionContext(draft.value, draft.cursor), [draft.value, draft.cursor]);
  const canComplete = !!context && !search && (!vimEnabled || vim.current.mode === 'INSERT');
  const completionActive = canComplete && !menu.dismissed && (!context.midPrompt || !!context.query || menu.expanded);
  const needsSkills = completionActive && (context?.prefix === '/' || context?.prefix === '$') && client.toolsEnabled();
  // Filter the same catalog while a completion menu is open. The SDK still validates a skill when submitted.
  const completionSkills = useMemo(() => {
    if (!needsSkills) return [];
    try {
      return client.skills().skills.filter(skill => skill.visibility !== 'off');
    } catch {
      return undefined;
    }
  }, [client, needsSkills]);
  const completionData = useMemo(() => {
    if (!context || !completionActive) return {items: [] as Completion[], error: ''};
    try {
      const files = context.prefix === '@' && options.workspaceAccess ? client.listWorkspaceFiles(context.query) : [];
      return {
        items: getCompletions(context, completionSkills, files),
        error:
          context.prefix === '@' && !options.workspaceAccess ? 'Approve this folder to suggest workspace files.' : '',
      };
    } catch {
      return {items: [] as Completion[], error: 'Workspace suggestions unavailable from this SDK backend.'};
    }
  }, [client, context, completionActive, completionSkills, options.workspaceAccess]);
  const items = completionData.items;
  const selected =
    menu.selected === null
      ? items.findIndex(item => item.autoSelect !== false)
      : Math.min(menu.selected, items.length - 1);
  const startupSuggestion =
    !busy &&
    !draft.value &&
    !search &&
    !shortcuts &&
    footer === null &&
    status.messageCount === 0 &&
    (!vimEnabled || vim.current.mode === 'INSERT') &&
    !client.imageAttachments().length
      ? (options.startupSuggestion ?? 'Explain this codebase') || undefined
      : undefined;
  const acceptStartupSuggestion = () => {
    if (!startupSuggestion || draftRef.current.value) return false;
    change(createPasteState(startupSuggestion), false);
    return true;
  };
  const rememberUndo = (previous: PasteState, groupInsert: boolean) => {
    redo.current = [];
    if (groupInsert && insertUndo.current) return;
    undo.current.push(previous);
    if (undo.current.length > 100) undo.current.shift();
    insertUndo.current = groupInsert;
  };
  const change = (next: PasteState, showMenu = true, keepYank = false, keepKill = false, fromVim = false) => {
    if (!keepYank) yank.current = null;
    if (!keepKill) lastKill.current = false;
    const previous = draftRef.current;
    if (previous.value !== next.value || previous.pastes !== next.pastes) {
      rememberUndo(previous, vimEnabled && vim.current.mode === 'INSERT');
    }
    if (vimEnabled && !fromVim) {
      const reconciled = reconcileVim(vim.current, previous, next);
      vim.current = reconciled.state;
      next = reconciled.draft;
    }
    escapeAt.current = null;
    if (previous.value !== next.value) setDeletedHint(false);
    update(next);
    navigation.current = null;
    menu.setSelected(null);
    menu.setExpanded(false);
    menu.setDismissed(!showMenu);
  };
  const paste = (text: string) => {
    if (searchRef.current) {
      searchQuery(searchRef.current.query + safeText(text.replace(/\r\n?/g, '\n')));
      return;
    }
    const current = draftRef.current;
    const selection = vimEnabled ? vimSelection(vim.current, current) : undefined;
    if (selection) vim.current = {...vim.current, mode: 'NORMAL', anchor: undefined, pending: undefined, count: 0};
    change(
      insertPaste(selection ? {...current, selectionAnchor: selection[0], cursor: selection[1]} : current, text),
      false,
    );
  };
  const searchEntries = () => searchRef.current?.entries ?? [];
  const matchesFor = (query: string) =>
    searchEntries()
      .map((e, i) => ({e, i}))
      .filter(({e}) => e.content.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      .map(({i}) => i);
  const loadSearch = (scope: PromptHistoryScope): PromptHistoryEntry[] => {
    try {
      return client.promptHistory({scope});
    } catch {
      return scope === 'session'
        ? entriesRef.current
            .slice()
            .reverse()
            .map((content, i) => ({
              id: `local:${i}`,
              sessionId: status.activeSessionId ?? '',
              content,
              timestamp: '',
            }))
        : [];
    }
  };
  const setSearchState = (next: SearchState) => {
    searchRef.current = next;
    setSearch(next);
  };
  const searchQuery = (query: string) => {
    const current = searchRef.current;
    if (current) setSearchState({...current, query, selected: 0});
  };
  const searchMove = (step: number) => {
    const current = searchRef.current;
    if (!current) return;
    const count = matchesFor(current.query).length;
    setSearchState({...current, selected: Math.max(0, Math.min(count - 1, current.selected + step))});
  };
  const searchOpen = () => {
    menu.setDismissed(true);
    if (searchRef.current) searchMove(1);
    // The search starts from what is typed (first line), like the reference; Esc restores the draft.
    else {
      let scope: PromptHistoryScope = 'everywhere';
      try {
        client.promptHistory({scope});
      } catch {
        scope = 'session';
      }
      setSearchState({
        query: expandPastes(draftRef.current).split('\n')[0] ?? '',
        selected: 0,
        draft: draftRef.current,
        scope,
        entries: loadSearch(scope),
      });
    }
  };
  const closeSearch = (restore: boolean) => {
    if (restore && searchRef.current) update(searchRef.current.draft);
    searchRef.current = null;
    setSearch(null);
    menu.setDismissed(true);
  };
  const complete = (draft: PasteState, item: Completion) => {
    const active = completionContext(draft.value, draft.cursor);
    if (!active) return draft;
    const tail = draft.value.slice(draft.cursor);
    const suffixPattern = active.prefix === '/' ? /^\S*/ : active.prefix === ':' ? /^[a-z0-9_+-]*:?/i : /^[^\s@$]*/;
    const suffix = suffixPattern.exec(tail)?.[0] ?? '';
    const end = draft.cursor + suffix.length;
    const separator = draft.value[end] ?? '';
    const replacement = /\s/.test(separator) ? item.replacement.trimEnd() : item.replacement;
    const completed = replaceRange(draft, active.start, end, replacement);
    const advance = item.replacement.endsWith(' ') && (separator === ' ' || separator === '\t');
    return advance ? moveTo(completed, completed.cursor + 1) : completed;
  };
  const acceptCompletion = (item: Completion) => change(complete(draftRef.current, item), false);
  const accepted = (snapshot: PasteState, content: string) => {
    if (!mounted.current) return;
    acceptanceSequence.current++;
    history.record(content);
    undo.current = [];
    redo.current = [];
    insertUndo.current = false;
    if (vimEnabled)
      vim.current = {
        ...createVimState(),
        mode: vim.current.mode,
        register: vim.current.register,
        find: vim.current.find,
      };
    setNotice('');
    if (draftRef.current === snapshot) update(createPasteState());
  };
  const submitInternal = async (override?: string) => {
    const snapshot = draftRef.current;
    const content = (override ?? expandPastes(snapshot)).trim();
    if (!content && !client.imageAttachments().length) return;
    if (attaching.current) {
      report('Image paste is still being prepared; draft kept.');
      return;
    }
    if (client.imageAttachments().length && (busy || /^[/!#]/.test(content))) {
      report('Images need an idle chat message; draft kept.');
      return;
    }
    if (content.startsWith('/') && !client.isSkillCommand(content)) {
      if (!options.onCommand) {
        report('Slash command routing is not connected; draft kept.');
        return;
      }
      if (accepting.current) return;
      accepting.current = true;
      menu.setDismissed(true);
      try {
        if ((await options.onCommand(content)) !== false) accepted(snapshot, content);
      } catch {
        report('Command failed; draft kept.');
      } finally {
        accepting.current = false;
      }
      return;
    }
    if (busy) {
      if (content.startsWith('!') || content.startsWith('#')) {
        report('Shell and memory input cannot steer; draft kept. Wait or press Esc.');
        return;
      }
      try {
        const outcome = client.submitWhileBusy(content);
        if (outcome.disposition === 'rejected') {
          report(`Input not accepted (${outcome.reason}); draft kept.`);
          return;
        }
        accepted(snapshot, content);
        rerender();
        report(
          outcome.disposition === 'steered' ? 'Steering accepted.' : `Queued for next turn (${outcome.position}).`,
        );
      } catch {
        report('Steering was not accepted; draft kept.');
      }
      return;
    }
    if (accepting.current) return;
    accepting.current = true;
    try {
      if (content.startsWith('!')) {
        const command = content.slice(1).trim();
        if (!command) {
          report('Shell mode: type a command after !.');
          return;
        }
        if (!options.workspaceAccess || !client.toolsEnabled()) {
          report('Shell mode needs folder consent and workspace tools; draft kept.');
          return;
        }
        const abort = new AbortController();
        shellAbort.current = abort;
        setShellBusy(true);
        const callId = options.onShellStart?.(command);
        const result = await client.runShellCommand(command, {
          signal: abort.signal,
          onOutput: options.onShellOutput,
          callId: callId || undefined,
        });
        // A denied/failed command remains visible and is never reported as successful.
        if (mounted.current) options.onShellResult?.(result);
        if (result.status === 'ok') accepted(snapshot, content);
        setNotice(
          result.status === 'ok' && options.onShellResult
            ? ''
            : `Shell ${result.status}${result.code ? ` [${result.code}]` : ''}${result.sessionId ? ` · running session ${result.sessionId}` : ''}.`,
        );
      } else if (content.startsWith('#')) {
        const memory = content.slice(1).trim();
        if (!memory) {
          report('Memory mode: type a note after #.');
          return;
        }
        if (!options.onRemember) {
          report('Quick memory: Not implemented by the public SDK (write API missing); draft kept.');
          return;
        }
        if ((await options.onRemember(memory)) !== false) accepted(snapshot, content);
      } else if ((await options.onSubmit(content)) !== false) accepted(snapshot, content);
    } catch (error) {
      const code = error instanceof FutrynError ? error.code : 'ERROR';
      if (content.startsWith('!')) options.onShellError?.(code);
      report(`Input failed [${code}]; draft kept.`);
    } finally {
      accepting.current = false;
      shellAbort.current = null;
      if (mounted.current) setShellBusy(false);
    }
  };
  const submit = (override?: string) => {
    const task = submitInternal(override);
    pendingInput.current = task;
    return task;
  };
  const shutdown = async () => {
    shellAbort.current?.abort();
    await pendingInput.current;
  };
  const enter = () => {
    if (dismissShortcuts()) return;
    if (searchRef.current) {
      const found = matchesFor(searchRef.current.query)[searchRef.current.selected];
      if (found === undefined) closeSearch(true);
      else {
        const text = searchEntries()[found]!.content;
        searchRef.current = null;
        setSearch(null);
        change(createPasteState(text), false);
      }
      return;
    }
    const current = draftRef.current;
    if (current.value.slice(0, current.cursor).endsWith('\\')) {
      change(replaceRange(current, current.cursor - 1, current.cursor, '\n'), false);
      return;
    }
    const chosen = items[selected];
    if (chosen && context && (context.prefix !== '/' || context.midPrompt)) {
      acceptCompletion(chosen);
      return;
    }
    if (chosen && context?.prefix === '/') {
      const typed = expandPastes(current);
      const parsed = parseSlashCommand(typed);
      // Preserve exact aliases and existing arguments unless the user chose a different command.
      if (chosen.kind === 'command' && parsed.definition?.command === chosen.label) void submit(typed);
      else void submit(expandPastes(complete(current, chosen)));
      return;
    }
    void submit();
  };
  const queued = () => client.queuedInput().map(input => input.content);
  const navigate = (direction: -1 | 1, historyOnly = false) => {
    const current = draftRef.current;
    // Multi-line input: the caret moves between lines first; history starts at the first/last line.
    const vertical = historyOnly ? null : verticalMove(current, direction, options.inputWidth ?? 74);
    if (vertical) {
      update(vimEnabled ? reconcileVim(vim.current, current, vertical).draft : vertical);
      return;
    }
    const waiting = queued();
    if (direction < 0 && waiting.length) {
      try {
        // The store checks eligibility and removes only unclaimed text in the same transaction.
        // With an empty draft a sole shell can also be reclaimed, retaining its ! mode prefix.
        const entries = client.retractQueuedEntries({includeShell: !current.value, shellOnlyWhenAlone: true});
        const reclaimed = entries.map(e => e.content).join('\n');
        if (reclaimed) change(createPasteState([reclaimed, expandPastes(current)].filter(Boolean).join('\n')), false);
        else {
          if (waiting.some(text => text.startsWith('!')))
            report('Queued shell commands stay queued while other input is present.');
          rerender();
        }
      } catch {
        report('Queued input could not be retracted; draft kept.');
      }
      return;
    }
    const entries = entriesRef.current;
    if (!entries.length) return;
    const nav = navigation.current ?? {index: entries.length, draft: current};
    const index = Math.max(0, Math.min(entries.length, nav.index + direction));
    navigation.current = index === entries.length ? null : {...nav, index};
    const next = index === entries.length ? nav.draft : createPasteState(entries[index]!);
    vim.current = {...vim.current, column: undefined};
    update(vimEnabled ? reconcileVim(vim.current, current, next).draft : next);
    menu.setDismissed(true);
  };
  const pushKill = (text: string, backward = false) => {
    if (!text) return;
    const [top, ...rest] = killRing.current;
    killRing.current =
      lastKill.current && top !== undefined
        ? [backward ? text + top : top + text, ...rest]
        : [text, ...killRing.current].slice(0, 10);
  };
  const kill = (action: EditAction) => {
    const current = draftRef.current;
    const span = editSpan(current, action);
    if (!span) return;
    pushKill(spanText(current, span[0], span[1]), action !== 'killEnd' && action !== 'killWordForward');
    change(replaceRange(current, span[0], span[1], ''), false, false, true);
    lastKill.current = true;
    // Killing a line part (Ctrl+U / Ctrl+K) offers Ctrl+Y in the slot, like clearing the input does.
    if (action === 'killStart' || action === 'killEnd') setDeletedHint(true);
  };
  const yankText = () => {
    const current = draftRef.current;
    const text = killRing.current[0];
    if (!text) return;
    const start = Math.min(current.cursor, current.selectionAnchor ?? current.cursor);
    change(insertText(current, text), false, true);
    yank.current = {start, length: text.length, index: 0};
  };
  const yankPop = () => {
    const current = draftRef.current;
    const last = yank.current;
    const ring = killRing.current;
    if (!last || ring.length < 2 || current.cursor !== last.start + last.length) return;
    const index = (last.index + 1) % ring.length;
    change(replaceRange(current, last.start, last.start + last.length, ring[index]!), false, true);
    yank.current = {start: last.start, length: ring[index]!.length, index};
  };
  const nowMs = () => Date.now();
  const undoEdit = (forward = false) => {
    const source = forward ? redo.current : undo.current;
    const destination = forward ? undo.current : redo.current;
    const previous = source.pop();
    if (!previous) return false;
    const current = draftRef.current;
    destination.push(current);
    insertUndo.current = false;
    if (vimEnabled) vim.current = {...vim.current, insert: undefined, column: undefined};
    update(vimEnabled ? reconcileVim(vim.current, current, previous).draft : previous);
    navigation.current = null;
    menu.setDismissed(true);
    return true;
  };
  const stashPrompt = () => {
    const current = draftRef.current;
    if (current.value) {
      if (stash.current) {
        report('A prompt is already stashed; restore it from an empty input first.');
        return;
      }
      stash.current = current;
      change(createPasteState(), false);
      report('Prompt stashed. Press Ctrl+S on empty input to restore.');
    } else if (stash.current) {
      change(stash.current, false);
      stash.current = null;
      report('Prompt restored.');
    }
  };
  const bridge = (handler: (() => void) | undefined, feature: string) => {
    if (handler) handler();
    else report(`Not implemented: ${feature}.`);
  };
  /** Ctrl+X Ctrl+K: stop every running background subagent; the first press asks, a second within 3 s stops them. */
  const killAgents = () => {
    const running = client.subagents().filter(agent => agent.status === 'running' && agent.background);
    if (!running.length) {
      flash('No background agents are running.');
      return;
    }
    const now = nowMs();
    if (killAt.current === null || now - killAt.current > 3000) {
      killAt.current = now;
      flashSlot('Press ctrl+x ctrl+k again to stop background agents', 3000);
      return;
    }
    killAt.current = null;
    let stopped = 0;
    try {
      for (const agent of running) if (client.stopSubagent(agent.id)) stopped++;
      report(`Stopped ${stopped} background agent${stopped === 1 ? '' : 's'}.`);
    } catch {
      report('Not implemented: this backend cannot stop subagents.');
    }
  };
  /** Ctrl+Enter / Ctrl+X Ctrl+S: send what is queued plus the draft now (the turn is interrupted by the host). */
  const sendNow = () => {
    const current = draftRef.current;
    const hasDraft = !!current.value.trim() || client.imageAttachments().length > 0;
    if (!busy && hasDraft) {
      void submit();
      return;
    }
    if (!options.onSendQueuedNow) {
      report('Not implemented: sending queued messages now needs a host bridge.');
      return;
    }
    if (hasDraft) {
      const before = acceptanceSequence.current;
      void submit().then(() => {
        if (acceptanceSequence.current > before) options.onSendQueuedNow?.();
      });
    } else options.onSendQueuedNow();
  };
  const cycleEffort = (up: boolean) => {
    const efforts = status.activeModel?.reasoningEfforts ?? [];
    if (!efforts.length) return false;
    const at = efforts.indexOf(status.reasoningEffort ?? '');
    const next = Math.max(0, Math.min(efforts.length - 1, at + (up ? 1 : -1)));
    try {
      client.setReasoningEffort(efforts[next]!);
    } catch {
      report('Effort change rejected; current effort kept.');
    }
    return true;
  };
  const activeTasks = sessionTasks(client).filter(task => task.status === 'running');
  const runningTasks = () => activeTasks;
  const runningAgents = runningTasks;
  const footerAgent = () => {
    const list = runningAgents();
    return footer === null || !list.length ? undefined : list[Math.min(footer, list.length - 1)];
  };
  /** Footer keys apply only while an agent is selected; otherwise the key falls through to the input. */
  const inFooter = (fn: () => void) => () => {
    if (footer === null || searchRef.current) return false;
    if (!runningAgents().length) {
      setFooter(null);
      return false;
    }
    fn();
  };
  const moveFooter = (step: number) => {
    const count = runningAgents().length;
    setFooter(at => ((((at ?? 0) + step) % count) + count) % count);
  };
  const openFooter = () => {
    const selected = footerAgent();
    const handler = selected?.kind === 'shell' ? options.onOpenBackgroundTasks : options.onOpenAgents;
    bridge(handler ? () => handler(selected?.id) : undefined, 'task panel is not connected');
  };
  /** Every composer binding first closes the `?` table and is ignored while the history search owns the keys. */
  const guarded = (fn: (stroke: Keystroke) => void) => (stroke: Keystroke) => {
    if (dismissShortcuts() || searchRef.current) return;
    fn(stroke);
  };
  const acceptSearch = () => {
    const current = searchRef.current;
    if (!current) return false;
    const found = matchesFor(current.query)[current.selected];
    if (found === undefined) closeSearch(true);
    else {
      const text = searchEntries()[found]!.content;
      searchRef.current = null;
      setSearch(null);
      change(createPasteState(text), false);
    }
  };
  const searching =
    <T extends unknown[]>(fn: (...args: T) => void) =>
    (...args: T) => {
      if (!searchRef.current) return false;
      fn(...args);
    };
  const listing = (fn: () => void) => () => {
    if (!items.length || searchRef.current) return false;
    fn();
  };
  const applyVim = (token: string) => {
    if (!vimEnabled || searchRef.current || footer !== null) return false;
    if (dismissShortcuts()) return true;
    const current = draftRef.current;
    const before = vim.current;
    if (before.mode === 'INSERT' && token !== 'escape' && token !== 'enter') return false;
    const result = stepVim(before, current, token, options.inputWidth);
    vim.current = result.state;
    if (result.state.mode !== 'INSERT' || before.mode !== 'INSERT') insertUndo.current = false;
    if (result.draft !== current) change(result.draft, false, false, false, true);
    else if (result.state !== before) rerender();
    if (token === 'escape') {
      setSelectedImage(null);
      menu.setDismissed(true);
    }
    switch (result.effect) {
      case 'submit':
        void enter();
        break;
      case 'undo':
        undoEdit();
        break;
      case 'redo':
        if (!undoEdit(true)) searchOpen();
        break;
      case 'history':
        searchOpen();
        break;
      case 'older':
        navigate(-1, true);
        break;
      case 'newer':
        if (!current.value && !navigation.current && runningAgents().length) setFooter(0);
        else navigate(1, true);
        break;
      case 'help':
        shortcutsRef.current = true;
        setShortcuts(true);
        break;
    }
    return true;
  };
  /** Everything no binding wants: typing, cursor keys and the readline-style editing keys. Returns true when consumed. */
  const onKey = (text: string, key: Key): boolean => {
    if (key.eventType === 'release') return true;
    if (shortcutsRef.current) {
      dismissShortcuts();
      return true;
    }
    const current = draftRef.current;
    if (searchRef.current) {
      if (key.backspace || key.delete) searchQuery(edit(createPasteState(searchRef.current.query), 'backspace').value);
      else if (!key.ctrl && !key.meta && !key.escape && !key.return && !key.tab && text)
        searchQuery(searchRef.current.query + safeText(text));
      return true;
    }
    if (selectedImage !== null) {
      const images = client.imageAttachments();
      if (key.leftArrow || key.rightArrow)
        setSelectedImage(at => Math.max(0, Math.min(images.length - 1, (at ?? 0) + (key.leftArrow ? -1 : 1))));
      else if (key.backspace || key.delete) {
        const image = images[selectedImage];
        if (image) client.removeImageAttachment(image.id);
        setSelectedImage(images.length > 1 ? Math.min(selectedImage, images.length - 2) : null);
        rerender();
      } else {
        setSelectedImage(null);
        if (key.escape || key.downArrow) return true;
      }
      if (key.leftArrow || key.rightArrow || key.backspace || key.delete) return true;
    }
    if (!key.ctrl && !key.meta && key.leftArrow && current.cursor === 0 && client.imageAttachments().length) {
      setSelectedImage(client.imageAttachments().length - 1);
      return true;
    }
    if (key.super || key.hyper) return true;
    if (vimEnabled && vim.current.mode !== 'INSERT' && footer === null && !key.ctrl && !key.meta) {
      // The router has already tried remappable commands. Only character arguments
      // and coalesced text that cannot represent a single key reach this fallback.
      const pending = vim.current.pending?.kind;
      if (pending === 'replace' || pending === 'find') applyVim(safeText(text));
      else if (text && !key.shift && !key.return && !key.escape && !key.tab && [...text].length > 1) paste(text);
      else if (vim.current.pending || vim.current.count) applyVim('');
      return true;
    }

    if (!vimEnabled && !key.ctrl && !key.meta && text === '?' && !current.value) {
      shortcutsRef.current = true;
      setShortcuts(true);
      return true;
    }
    if (key.escape || key.return || key.tab) return true;
    if (key.shift && (key.upArrow || key.downArrow) && !key.ctrl && !key.meta) {
      if (cycleEffort(key.upArrow)) return true;
      // A model without effort levels: Shift+↑/↓ extends the selection by a line.
      const vertical = verticalMove(current, key.upArrow ? -1 : 1, options.inputWidth ?? 74);
      const target = vertical ? vertical.cursor : key.upArrow ? 0 : current.value.length;
      change(moveTo(current, target, true), false);
      return true;
    }
    if (key.meta || key.ctrl) {
      const letter = text.toLowerCase();
      if (key.backspace || (key.meta && key.delete)) kill('deleteWordBack');
      else if (key.leftArrow || key.rightArrow || (key.meta && (letter === 'b' || letter === 'f'))) {
        const left = key.leftArrow || letter === 'b';
        const cursor = left ? wordLeft(current.value, current.cursor) : wordRight(current.value, current.cursor);
        change(moveTo(current, cursor, key.shift), false);
      } else if (key.meta && letter === 'd') kill('killWordForward');
      else if (key.meta && letter === 'y') yankPop();
      else if (key.ctrl && letter === 'y') yankText();
      else if (key.ctrl && letter === 'a') change(edit(current, 'start'), false);
      else if (key.ctrl && letter === 'e') change(edit(current, 'end'), false);
      else if (key.ctrl && letter === 'k') kill('killEnd');
      else if (key.ctrl && letter === 'u') kill('killStart');
      else if (key.ctrl && letter === 'w') kill('killWord');
      return true;
    }
    if (key.leftArrow || key.rightArrow) {
      if (key.rightArrow && !key.shift && acceptStartupSuggestion()) return true;
      const next = moveCursor(current, key.leftArrow ? -1 : 1, key.shift);
      const cursorInsideWord = /^\S/.test(next.value.slice(next.cursor));
      change(next, !key.shift && cursorInsideWord);
    } else if (key.home || key.end) {
      if (key.shift) change(moveTo(current, lineEdge(current, key.home ? 'start' : 'end'), true), false);
      else if (!current.value) options.onEmptyHomeEnd?.(key.home ? 'start' : 'end');
      else change(edit(current, key.home ? 'start' : 'end'), false);
    } else if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) return true;
    else if (key.backspace || key.delete) change(edit(current, key.backspace ? 'backspace' : 'delete'));
    else if (text) {
      if (text.length > 1 && /[\r\n]/.test(text)) paste(text);
      else {
        const next = insertText(current, safeText(text));
        const code = text === ':' ? emojiShortcode(next.value, next.cursor) : undefined;
        change(code ? replaceRange(next, code.from, next.cursor, code.emoji) : next);
      }
    }
    return true;
  };
  const closeFooter = inFooter(() => {
    const agent = footerAgent();
    if (!agent) return;
    try {
      const stopping = agent.foreground
        ? Promise.resolve(client.stopSubagent(agent.id))
        : client.stopBackgroundTask(agent.id);
      void stopping
        .then(stopped => {
          report(stopped ? 'Stopping task…' : 'Task is not running.');
        })
        .catch(() => report('Task could not be stopped.'));
    } catch {
      report('Not implemented: this backend cannot stop subagents.');
    }
  });
  const modalBindings = Object.fromEntries(
    VIM_COMMANDS.map(({token}) => [
      `vim:${token === ' ' ? 'space' : token}`,
      (stroke: Keystroke) => {
        // Find/replace consume the actual character even if that key has a remap.
        const pending = vim.current.pending?.kind;
        if (
          (pending === 'replace' || pending === 'find') &&
          !stroke.ctrl &&
          !stroke.alt &&
          !stroke.super &&
          stroke.key !== 'escape' &&
          stroke.key !== 'enter'
        ) {
          const char = stroke.key === 'space' ? ' ' : stroke.shift ? stroke.key.toUpperCase() : stroke.key;
          return applyVim(isPrintable(stroke) ? char : '');
        }
        return applyVim(token);
      },
    ]),
  );
  const insertBindings = {'vim:escape': modalBindings['vim:escape']!, 'vim:enter': modalBindings['vim:enter']!};
  useKeybindings(
    {
      Global: {
        'history:search': () => {
          if (!dismissShortcuts()) searchOpen();
        },
        'app:toggleTodos': guarded(() => bridge(options.onToggleTasks, 'task visibility is not connected')),
      },
      get Vim() {
        if (!vimEnabled) return undefined;
        return vim.current.mode === 'INSERT' ? insertBindings : modalBindings;
      },
      Chat: {
        'chat:submit': guarded(() => enter()),
        'chat:queueSubmit': guarded(() => void submit()),
        'chat:sendNow': guarded(sendNow),
        'chat:newline': guarded(() => change(insertText(draftRef.current, '\n'), false)),
        'chat:modelPicker': guarded(() => {
          if (options.onCommand) {
            void (async () => {
              try {
                await options.onCommand!('/model');
              } catch {
                report('Model picker failed; draft kept.');
              }
            })();
          } else report('Not implemented: model picker is not connected.');
        }),
        'chat:fastMode': guarded(() => flashSlot('Not implemented: fast mode (no provider API for it)')),
        'chat:thinkingToggle': guarded(() =>
          flashSlot('Not implemented: extended-thinking toggle (use /effort for the reasoning effort)'),
        ),
        'chat:clearInput': guarded(() => bridge(options.onRedraw, 'screen redraw bridge')),
        'chat:undo': guarded(() => undoEdit()),
        'chat:externalEditor': guarded(() => bridge(options.onEditor, '$EDITOR bridge')),
        'chat:stash': guarded(stashPrompt),
        'chat:imagePaste': guarded(() => {
          if (!options.onPasteImage && !options.onReadClipboardImage) {
            flashSlot('Not implemented: image clipboard is unavailable on this host');
            return;
          }
          if (attaching.current) return;
          if (busy) {
            report('Wait for the active turn before attaching an image.');
            return;
          }
          attaching.current = true;
          const owner = [
            client.activeSession()?.id,
            client.status().activeAccount?.id,
            client.status().activeModel?.id,
          ].join(':');
          void (async () => {
            try {
              const image = options.onReadClipboardImage ? await options.onReadClipboardImage() : undefined;
              if (!options.onReadClipboardImage) options.onPasteImage?.();
              if (image) {
                const currentOwner = [
                  client.activeSession()?.id,
                  client.status().activeAccount?.id,
                  client.status().activeModel?.id,
                ].join(':');
                if (!mounted.current || owner !== currentOwner) {
                  report('Image paste cancelled because the session changed.');
                  return;
                }
                await client.attachImage(image);
                rerender();
              }
            } catch (error) {
              report(`Image paste failed [${error instanceof FutrynError ? error.code : 'ERROR'}]; draft kept.`);
            } finally {
              attaching.current = false;
            }
          })();
        }),
        'chat:suspend': guarded(() => bridge(options.onSuspend, 'terminal suspend bridge')),
        'chat:killAgents': guarded(killAgents),
        'task:background': guarded(() => {
          try {
            if (options.onBackgroundTask) options.onBackgroundTask();
            else
              report(
                client.backgroundCurrentTask()
                  ? 'Task moved to background.'
                  : 'No foreground task can be moved to background.',
              );
          } catch {
            report('Task could not be moved to background.');
          }
        }),
        'history:previous': guarded(() => navigate(-1)),
        'history:next': guarded(() => {
          // Down on an empty input with nothing to scroll to moves focus to the footer's agent entry.
          if (!draftRef.current.value && !navigation.current && runningAgents().length) setFooter(0);
          else navigate(1);
        }),
      },
      Footer: {
        'footer:next': inFooter(() => moveFooter(1)),
        'footer:previous': inFooter(() => moveFooter(-1)),
        'footer:up': inFooter(() => setFooter(null)),
        'footer:clearSelection': inFooter(() => setFooter(null)),
        'footer:down': inFooter(openFooter),
        'footer:open': inFooter(openFooter),
        'footer:close': closeFooter,
        'footer:stop': closeFooter,
      },
      Autocomplete: {
        'autocomplete:accept': () => {
          if (dismissShortcuts()) return true;
          if (searchRef.current) return false;
          if (canComplete && context.midPrompt && !context.query && (!menu.expanded || menu.dismissed)) {
            menu.setDismissed(false);
            menu.setExpanded(true);
            return true;
          }
          const item = items[selected] ?? items[0];
          if (!item) return acceptStartupSuggestion();
          acceptCompletion(item);
          return true;
        },
        'autocomplete:dismiss': () => {
          if (!completionActive || searchRef.current) return false;
          menu.setDismissed(true);
          return true;
        },
        'autocomplete:previous': listing(() => menu.setSelected(selected <= 0 ? items.length - 1 : selected - 1)),
        'autocomplete:next': listing(() => menu.setSelected((selected + 1) % items.length)),
      },
      HistorySearch: {
        'historySearch:previous': searching(() => searchMove(1)),
        'historySearch:next': searching(() => searchMove(-1)),
        'historySearch:accept': searching(acceptSearch),
        'historySearch:cancel': searching(() => closeSearch(true)),
        'historySearch:scope': searching(() => {
          const current = searchRef.current;
          if (!current) return;
          const scopes: PromptHistoryScope[] = ['session', 'project', 'everywhere'];
          const scope = scopes[(scopes.indexOf(current.scope) + 1) % scopes.length]!;
          setSearchState({...current, scope, entries: loadSearch(scope), selected: 0});
          setNotice('');
        }),
      },
    },
    {isActive: options.isActive, onKey},
  );
  // Ink 8 separates bracketed paste from keystrokes. Respect the phase-0 input scope.
  usePaste(paste, {isActive: useInputEnabled(options.isActive)});
  const remember = (state: PasteState) => {
    pushKill(expandPastes(state));
  };
  /** Wire to InkApp.onInterrupt; Shell is the sole owner of Esc. */
  const interrupt = () => {
    if (dismissShortcuts()) return true;
    if (applyVim('escape')) return true;
    if (selectedImage !== null) {
      setSelectedImage(null);
      return true;
    }
    if (shellAbort.current) {
      shellAbort.current.abort();
      return true;
    }
    if (busy) return false; // Host owns the active generation AbortController.
    if (searchRef.current) {
      closeSearch(true);
      return true;
    }
    if (items.length) {
      menu.setDismissed(true);
      return true;
    }
    const now = Date.now();
    if (escapeAt.current !== null && now - escapeAt.current < 1500) {
      escapeAt.current = null;
      if (draftRef.current.value) {
        // The cleared draft goes to the history (Up brings it back) and to the kill ring (Ctrl+Y).
        history.record(expandPastes(draftRef.current));
        remember(draftRef.current);
        change(createPasteState(), false);
        setNotice('');
        setDeletedHint(true);
      } else if (options.onRewind) options.onRewind();
      else report('Not implemented: conversation rewind is not connected.');
    } else {
      escapeAt.current = now;
      flash('Esc again to clear', 1500);
    }
    return true;
  };
  return {
    status,
    context: contextEstimate,
    shortcuts,
    vimMode: vimEnabled ? vim.current.mode : undefined,
    vimRange: vimEnabled ? vimSelection(vim.current, draft) : undefined,
    shortcutColumns: footerShortcutColumns(
      !!status.activeModel?.reasoningEfforts?.length,
      options.transcriptItems,
      vimEnabled,
    ),
    /** Shell must call this before exit; its startup/teardown lifecycle stays authoritative. */
    confirmExit: () => {
      dismissShortcuts();
      if (searchRef.current) {
        closeSearch(true);
        return false;
      }
      if (draftRef.current.value) {
        // Ctrl+C on text clears it (Ctrl+Y brings it back); it does not arm the exit.
        remember(draftRef.current);
        change(createPasteState(), false);
        setNotice('');
        setDeletedHint(true);
        exitAt.current = null;
        return false;
      }
      const now = Date.now();
      if (exitAt.current !== null && now - exitAt.current < 800) {
        exitAt.current = null;
        return true;
      }
      exitAt.current = now;
      flash('Press Ctrl-C again to exit', 800);
      return false;
    },
    /**
     * Ctrl+D: with text it deletes the character after the cursor; on an empty input the first press shows a hint and a
     * second one within 800 ms returns true (the shell then exits).
     */
    pressEof: () => {
      dismissShortcuts();
      const current = draftRef.current;
      if (current.value) {
        exitDAt.current = null;
        change(edit(current, 'delete'));
        return false;
      }
      const now = nowMs();
      if (exitDAt.current !== null && now - exitDAt.current < 800) {
        exitDAt.current = null;
        return true;
      }
      exitDAt.current = now;
      flash('Press Ctrl-D again to exit', 800);
      return false;
    },
    flash,
    /** Right-aligned hint above the input: set after Ctrl+C / Esc Esc removed text. */
    pasteDeletedHint: deletedHint,
    /** Messages waiting behind the running turn, oldest first. */
    queued: queued(),
    tasks: runningTasks(),
    selectedTask: footerAgent()?.id,
    agents: runningTasks().filter(task => task.kind === 'agent').length,
    backgroundShells: activeTasks.filter(task => task.kind === 'shell').length + (options.backgroundShells ?? 0),
    images: client.imageAttachments(),
    selectedImage,
    draft,
    setDraft: change,
    content: useMemo(() => expandPastes(draft), [draft]),
    history: history.entries,
    search,
    slotNotice,
    notice:
      footer !== null && footerAgent()
        ? `${footerAgent()!.kind} ${Math.min(footer, runningAgents().length - 1) + 1}/${runningAgents().length}: ${safeText(footerAgent()!.description).slice(0, 40)} · enter to open · x to stop · esc to leave`
        : notice,
    busy,
    items,
    selected,
    completionRunsCommand: completionActive && context?.prefix === '/' && !context.midPrompt,
    completionError:
      completionData.error ||
      (completionActive && context?.prefix === '/' && !context.midPrompt && !context.previousSkills && !items.length
        ? `No commands match "/${safeText(context.query).slice(0, 80)}"`
        : ''),
    startupSuggestion,
    workspaceAccess: !!options.workspaceAccess,
    submit,
    paste,
    interrupt,
    shutdown,
  };
}
export type ComposerController = ReturnType<typeof useComposer>;
