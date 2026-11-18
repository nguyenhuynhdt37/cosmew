import {useEffect, useMemo, useRef, useState} from 'react';
import {usePaste, type Key} from 'ink';
import {FutrynError} from '@futryn/contracts';
import {SLASH_COMMANDS, acceptSlashSelection, type FutrynClient} from '@futryn/sdk';
import {useClientEvents, useFutrynClient, useInputEnabled, useKeymap, useTextInput, keyAction} from '../../hooks';
import {safeText} from '../../ui';
import {completionContext, getCompletions, useAutocomplete, type Completion} from '../autocomplete';
import {recordHistory, searchHistory, useHistory} from '../history';
import {createPasteState, expandPastes, insertPaste, replaceRange, type PasteState} from '../paste';
import {edit, insertText, moveCursor, verticalMove} from './logic';

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
  onNotice?: (message: string) => void;
  busy?: boolean;
  isActive?: boolean;
  /** Set only after folder consent; the SDK list API does not enforce this UI gate. */
  workspaceAccess?: boolean;
  initialValue?: string;
  initialHistory?: readonly string[];
  inputWidth?: number;
  onEmptyHomeEnd?: (edge: 'start' | 'end') => void;
}
interface SearchState {
  query: string;
  index: number;
  draft: PasteState;
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
  const [draft, setDraft] = useState(() => createPasteState(safeText(options.initialValue ?? '')));
  const draftRef = useRef(draft);
  const update = (next: PasteState) => {
    draftRef.current = next;
    setDraft(next);
  };
  const [initialSession] = useState(() => client.activeSession());
  const [initialEntries] = useState(
    () =>
      options.initialHistory ??
      initialSession?.messages.filter(message => message.role === 'user').map(message => message.content) ??
      [],
  );
  const history = useHistory(initialEntries);
  const entriesRef = useRef(history.entries);
  entriesRef.current = history.entries;
  const navigation = useRef<{index: number; draft: PasteState} | null>(null);
  const [search, setSearch] = useState<SearchState | null>(null);
  const searchRef = useRef(search);
  searchRef.current = search;
  const [notice, setNotice] = useState('');
  const [shellBusy, setShellBusy] = useState(false);
  const shellAbort = useRef<AbortController | null>(null);
  const accepting = useRef(false);
  const pendingInput = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  const sessionId = useRef(initialSession?.id);
  const menu = useAutocomplete();
  const busy = !!options.busy || shellBusy;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      shellAbort.current?.abort();
    };
  }, []);
  useClientEvents({
    reactive: event => {
      // Session changes emit idle. Do not clone the full SDK session for token events.
      if (event.kind !== 'idle') return;
      const id = client.activeSession()?.id;
      if (id !== sessionId.current) {
        sessionId.current = id;
        // Keep the draft when moving sessions, but never navigate a stale history index.
        history.setEntries(items => sessionHistory(client).reduce((all, text) => recordHistory(all, text), items));
        navigation.current = null;
      }
    },
  });
  const report = (message: string) => {
    if (mounted.current) setNotice(message);
    options.onNotice?.(message);
  };
  const context = useMemo(() => completionContext(draft.value, draft.cursor), [draft.value, draft.cursor]);
  const completionData = useMemo(() => {
    if (!context || menu.dismissed || search) return {items: [] as Completion[], error: ''};
    try {
      const files = context.prefix === '@' && options.workspaceAccess ? client.listWorkspaceFiles(context.query) : [];
      return {
        items: getCompletions(context, client.skills().skills, files),
        error:
          context.prefix === '@' && !options.workspaceAccess ? 'Approve this folder to suggest workspace files.' : '',
      };
    } catch {
      return {items: [] as Completion[], error: 'Workspace suggestions unavailable from this SDK backend.'};
    }
  }, [client, context, menu.dismissed, search, options.workspaceAccess]);
  const items = completionData.items;
  const selected = Math.min(menu.selected, Math.max(0, items.length - 1));
  const change = (next: PasteState, showMenu = true) => {
    update(next);
    navigation.current = null;
    menu.setSelected(0);
    menu.setDismissed(!showMenu);
  };
  const paste = (text: string) => {
    if (searchRef.current) {
      searchQuery(searchRef.current.query + safeText(text.replace(/\r\n?/g, '\n')));
      return;
    }
    change(insertPaste(draftRef.current, text), false);
  };
  const find = (query: string, before: number, saved: PasteState) => {
    const index = searchHistory(entriesRef.current, query, before);
    const next = {query, index, draft: saved};
    searchRef.current = next;
    setSearch(next);
    if (index >= 0) update(createPasteState(entriesRef.current[index]!));
  };
  const searchQuery = (query: string) =>
    find(query, entriesRef.current.length, searchRef.current?.draft ?? draftRef.current);
  const searchOlder = () => {
    const current = searchRef.current;
    menu.setDismissed(true);
    find(
      current?.query ?? '',
      current && current.index >= 0 ? current.index : entriesRef.current.length,
      current?.draft ?? draftRef.current,
    );
  };
  const closeSearch = (restore: boolean) => {
    if (restore && searchRef.current) update(searchRef.current.draft);
    searchRef.current = null;
    setSearch(null);
    menu.setDismissed(true);
  };
  const acceptCompletion = (item: Completion) => {
    const active = completionContext(draftRef.current.value, draftRef.current.cursor);
    if (active) change(replaceRange(draftRef.current, active.start, draftRef.current.cursor, item.replacement), false);
  };
  const accepted = (snapshot: PasteState, content: string) => {
    if (!mounted.current) return;
    history.record(content);
    if (draftRef.current === snapshot) change(createPasteState(), false);
  };
  const submitInternal = async (override?: string) => {
    const snapshot = draftRef.current;
    const content = (override ?? expandPastes(snapshot)).trim();
    if (!content) return;
    if (content.startsWith('/') && !client.isSkillCommand(content)) {
      if (!options.onCommand) {
        report('Slash command routing is not connected; draft kept.');
        return;
      }
      if (accepting.current) return;
      accepting.current = true;
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
        report(
          `Shell ${result.status}${result.code ? ` [${result.code}]` : ''}${result.sessionId ? ` · running session ${result.sessionId}` : ''}.`,
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
    if (searchRef.current) {
      closeSearch(searchRef.current.index < 0);
      return;
    }
    const current = draftRef.current;
    if (current.value.slice(0, current.cursor).endsWith('\\')) {
      change(replaceRange(current, current.cursor - 1, current.cursor, '\n'), false);
      return;
    }
    const chosen = items[selected];
    if (chosen && context?.prefix === '@') {
      acceptCompletion(chosen);
      return;
    }
    if (chosen && context?.prefix === '$') {
      acceptCompletion(chosen);
      return;
    }
    if (chosen && context?.prefix === '/') {
      if (chosen.kind === 'skill') {
        void submit(expandPastes(replaceRange(current, context.start, current.cursor, chosen.replacement)));
        return;
      }
      const definition = SLASH_COMMANDS.find(command => command.command === chosen.label);
      void submit(acceptSlashSelection(expandPastes(current), definition));
      return;
    }
    void submit();
  };
  const navigate = (direction: -1 | 1) => {
    if (searchRef.current) {
      if (direction < 0) searchOlder();
      return;
    }
    if (items.length) {
      menu.setSelected((selected + direction + items.length) % items.length);
      return;
    }
    const current = draftRef.current;
    const vertical = verticalMove(current, direction, options.inputWidth ?? 74);
    if (vertical && !navigation.current) {
      update(vertical);
      return;
    }
    const entries = entriesRef.current;
    if (!entries.length) return;
    const nav = navigation.current ?? {index: entries.length, draft: current};
    const index = Math.max(0, Math.min(entries.length, nav.index + direction));
    navigation.current = index === entries.length ? null : {...nav, index};
    update(index === entries.length ? nav.draft : createPasteState(entries[index]!));
    menu.setDismissed(true);
  };
  useKeymap(
    {
      submit: enter,
      newline: () => change(insertText(draftRef.current, '\n'), false),
      previous: () => navigate(-1),
      next: () => navigate(1),
      history: searchOlder,
    },
    {isActive: options.isActive},
  );
  const input = (text: string, key: Key) => {
    if (key.eventType === 'release' || keyAction(text, key)) return;
    if (searchRef.current) {
      if (key.ctrl && text === 'g') closeSearch(true);
      else if (key.backspace || key.delete)
        searchQuery(edit(createPasteState(searchRef.current.query), 'backspace').value);
      else if (!key.ctrl && !key.meta && text) searchQuery(searchRef.current.query + safeText(text));
      return;
    }
    if (key.super || key.hyper) return;
    const current = draftRef.current;
    if ((key.meta && key.return) || (key.ctrl && text === 'j')) {
      change(insertText(current, '\n'), false);
      return;
    }
    if (key.tab && !key.shift) {
      const item = items[selected];
      if (item) acceptCompletion(item);
      return;
    }
    if (key.ctrl) {
      const action = ({a: 'start', e: 'end', k: 'killEnd', u: 'killStart', w: 'killWord'} as const)[text as 'a'];
      if (action) change(edit(current, action), false);
      return;
    }
    if (key.meta && (key.leftArrow || key.rightArrow)) {
      const cursor = key.leftArrow
        ? current.value.slice(0, current.cursor).replace(/\S+\s*$/, '').length
        : current.cursor +
          (/^\s*\S+\s*/.exec(current.value.slice(current.cursor))?.[0].length ?? current.value.length - current.cursor);
      // Word movement snaps across paste markers as one unit.
      const paste = current.pastes.find(item => cursor > item.start && cursor < item.end);
      change(
        {...current, cursor: paste ? (key.leftArrow ? paste.start : paste.end) : cursor, selectionAnchor: undefined},
        false,
      );
    } else if (key.meta) return;
    else if (key.leftArrow || key.rightArrow) change(moveCursor(current, key.leftArrow ? -1 : 1, key.shift), false);
    else if (key.home || key.end) {
      if (!current.value) options.onEmptyHomeEnd?.(key.home ? 'start' : 'end');
      else change(edit(current, key.home ? 'start' : 'end'), false);
    } else if (key.backspace || key.delete) change(edit(current, key.backspace ? 'backspace' : 'delete'));
    else if (text) {
      if (text.length > 1 && /[\r\n]/.test(text)) paste(text);
      else change(insertText(current, safeText(text)));
    }
  };
  useTextInput(input, {isActive: options.isActive});
  // Ink 8 separates bracketed paste from keystrokes. Respect the phase-0 input scope.
  usePaste(paste, {isActive: useInputEnabled(options.isActive)});
  /** Wire to InkApp.onInterrupt; Shell is the sole owner of Esc. */
  const interrupt = () => {
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
    if (draftRef.current.value) {
      change(createPasteState(), false);
      return true;
    }
    return false;
  };
  return {
    draft,
    setDraft: change,
    content: useMemo(() => expandPastes(draft), [draft]),
    history: history.entries,
    search,
    notice,
    busy,
    items,
    selected,
    completionError: completionData.error,
    submit,
    paste,
    interrupt,
    shutdown,
  };
}
export type ComposerController = ReturnType<typeof useComposer>;
