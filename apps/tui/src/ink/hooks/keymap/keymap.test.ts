import {afterEach, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Key} from 'ink';
import {
  CHORD_TIMEOUT_MS,
  CONTEXT_RANK,
  DEFAULT_BINDINGS,
  KEY_CONTEXTS,
  KeyRouter,
  KeymapStore,
  buildKeymap,
  defaultKeymap,
  ensureKeybindingsFile,
  fromInk,
  keyLabel,
  keybindingsLogPath,
  keybindingsPath,
  keybindingsTemplate,
  loadKeybindings,
  lookup,
  parseChord,
  parseKeystroke,
  shortcutColumns,
  watchKeybindings,
  formatChord,
  type Clock,
  type ContextHandlers,
} from './index';

const base: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};
const ctrl = (letter: string): [string, Key] => [letter, {...base, ctrl: true}];
const plain = (input: string): [string, Key] => [input, base];
/** Manual clock: timers fire only when the test advances time. */
function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, {at: number; run: () => void}>();
  const clock: Clock = {
    now: () => now,
    setTimeout: (run, ms) => {
      const id = next++;
      timers.set(id, {at: now + ms, run});
      return id;
    },
    clearTimeout: handle => void timers.delete(handle as number),
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.run();
        }
      }
    },
  };
}
function router(handlers: ContextHandlers[], options: {keymap?: ReturnType<typeof defaultKeymap>; clock?: Clock} = {}) {
  const notices: string[] = [];
  const instance = new KeyRouter({
    keymap: () => options.keymap ?? defaultKeymap(),
    clock: options.clock,
    onNotice: message => notices.push(message),
  });
  for (const set of handlers) instance.register({active: true, handlers: set});
  return {router: instance, notices};
}

test('keystroke parser: modifiers, aliases, case-insensitivity and chords', () => {
  expect(parseKeystroke('Ctrl+K')).toEqual({
    ok: true,
    value: {key: 'k', ctrl: true, alt: false, shift: false, super: false},
  });
  for (const alias of ['alt+p', 'opt+P', 'Option+p', 'meta+p'])
    expect(parseKeystroke(alias)).toEqual({
      ok: true,
      value: {key: 'p', ctrl: false, alt: true, shift: false, super: false},
    });
  for (const alias of ['cmd+k', 'command+k', 'super+k', 'win+k'])
    expect(parseKeystroke(alias)).toMatchObject({ok: true, value: {key: 'k', super: true}});
  expect(parseKeystroke('Esc')).toMatchObject({ok: true, value: {key: 'escape'}});
  expect(parseKeystroke('escape')).toMatchObject({ok: true, value: {key: 'escape'}});
  expect(parseKeystroke('Return')).toMatchObject({ok: true, value: {key: 'enter'}});
  expect(parseKeystroke('shift+TAB')).toMatchObject({ok: true, value: {key: 'tab', shift: true}});
  expect(parseKeystroke('ctrl+shift+-')).toMatchObject({ok: true, value: {key: '-', ctrl: true, shift: true}});
  expect(parseKeystroke('PageUp')).toMatchObject({ok: true, value: {key: 'pageup'}});
  expect(parseKeystroke('ctrl+Home')).toMatchObject({ok: true, value: {key: 'home', ctrl: true}});
  expect(parseKeystroke('del')).toMatchObject({ok: true, value: {key: 'delete'}});
  expect(parseKeystroke('space')).toMatchObject({ok: true, value: {key: 'space'}});
  const chord = parseChord('ctrl+x Ctrl+K');
  expect(chord.ok && formatChord(chord.value)).toBe('ctrl+x ctrl+k');
  // Errors are reported, never guessed.
  expect(parseKeystroke('hyper+k')).toMatchObject({ok: false, error: expect.stringContaining('Unknown modifier')});
  expect(parseKeystroke('ctrl+')).toMatchObject({ok: false});
  expect(parseKeystroke('ctrl+nonsense')).toMatchObject({ok: false, error: expect.stringContaining('Unknown key')});
  expect(parseChord('ctrl+ k')).toMatchObject({ok: false, error: expect.stringContaining('space follows')});
  expect(parseChord('')).toMatchObject({ok: false});
});
test('Ink keys translate to keystrokes, including the line feed (Ctrl+J) and Alt+Enter', () => {
  expect(fromInk(...ctrl('a'))).toMatchObject({key: 'a', ctrl: true});
  expect(fromInk('\n', base)).toMatchObject({key: 'j', ctrl: true});
  expect(fromInk('', {...base, return: true, meta: true})).toMatchObject({key: 'enter', alt: true});
  expect(fromInk('', {...base, return: true, shift: true})).toMatchObject({key: 'enter', shift: true});
  expect(fromInk('G', {...base, shift: true})).toMatchObject({key: 'g', shift: true});
  expect(fromInk('', {...base, home: true, ctrl: true})).toMatchObject({key: 'home', ctrl: true});
  expect(fromInk(' ', base)).toMatchObject({key: 'space'});
  expect(fromInk('abc', base)).toBeUndefined(); // pasted text is not a keystroke
  expect(fromInk('a', {...base, eventType: 'release'})).toBeUndefined();
});
test('defaults: every context exists, every default chord parses and is unique within its context', () => {
  expect(KEY_CONTEXTS.length).toBe(17);
  for (const context of KEY_CONTEXTS) expect(CONTEXT_RANK[context]).toBeGreaterThanOrEqual(0);
  const seen = new Set<string>();
  for (const entry of DEFAULT_BINDINGS) {
    for (const keys of entry.keys) {
      const chord = parseChord(keys);
      expect(chord.ok, `${entry.action}: ${keys}`).toBe(true);
      if (!chord.ok) continue;
      const slot = `${entry.context}|${formatChord(chord.value)}`;
      expect(seen.has(slot), `duplicate default ${slot}`).toBe(false);
      seen.add(slot);
    }
  }
  const keymap = defaultKeymap();
  const killChord = parseChord('ctrl+x ctrl+k');
  expect(killChord.ok && lookup(keymap, 'Chat', killChord.value)).toBe('chat:killAgents');
  expect(keyLabel(keymap, 'Chat', 'chat:modelPicker')).toBe('alt+p');
  expect(keymap.warnings).toEqual([]);
});
test('router: the innermost context wins, a declining handler falls through, Global is last', () => {
  const calls: string[] = [];
  const {router: r} = router([
    {Global: {'app:toggleTodos': () => void calls.push('global')}},
    {Chat: {'chat:undo': () => void calls.push('chat')}},
    {Select: {'select:next': () => void calls.push('select')}},
  ]);
  const [i1, k1] = ctrl('t');
  expect(r.dispatch(i1, k1)).toBe(true);
  expect(calls).toEqual(['global']);
  // Both Select (down) and Chat (history:next) could take Down; only Select has a handler here.
  expect(r.dispatch('', {...base, downArrow: true})).toBe(true);
  expect(calls).toEqual(['global', 'select']);
  // Declining hands the key to the next context.
  const order: string[] = [];
  const {router: r2} = router([
    {Chat: {'history:next': () => void order.push('chat')}},
    {Select: {'select:next': () => (order.push('select-declined'), false)}},
  ]);
  r2.dispatch('', {...base, downArrow: true});
  expect(order).toEqual(['select-declined', 'chat']);
});
test('router: inactive registrations are ignored, unbound keys reach raw handlers last', () => {
  const raw: string[] = [];
  const instance = new KeyRouter({keymap: () => defaultKeymap()});
  const hits: string[] = [];
  instance.register({active: false, handlers: {Chat: {'chat:undo': () => void hits.push('background')}}});
  instance.register({
    active: true,
    handlers: {Chat: {'chat:stash': () => void hits.push('stash')}},
    onKey: input => void raw.push(input),
  });
  instance.dispatch(...ctrl('_'));
  expect(hits).toEqual([]);
  expect(raw).toEqual(['_']);
  instance.dispatch(...ctrl('s'));
  expect(hits).toEqual(['stash']);
  instance.dispatch(...plain('q'));
  expect(raw).toEqual(['_', 'q']);
});
test('chords: ctrl+x waits for the next key, completes, and times out after 3 s with a notice (fake clock)', () => {
  const time = fakeClock();
  const calls: string[] = [];
  const {router: r, notices} = router(
    [{Chat: {'chat:killAgents': () => void calls.push('kill'), 'chat:queueSubmit': () => void calls.push('queue')}}],
    {clock: time.clock},
  );
  expect(r.dispatch(...ctrl('x'))).toBe(true);
  expect(r.pending).toBe('ctrl+x');
  expect(calls).toEqual([]);
  time.advance(CHORD_TIMEOUT_MS - 1);
  expect(r.pending).toBe('ctrl+x');
  expect(r.dispatch(...ctrl('k'))).toBe(true);
  expect(calls).toEqual(['kill']);
  expect(r.pending).toBe('');
  // Timeout: the chord is dropped with a brief notice and the second key is an ordinary key again.
  r.dispatch(...ctrl('x'));
  time.advance(CHORD_TIMEOUT_MS);
  expect(r.pending).toBe('');
  expect(notices).toEqual(['Chord cancelled']);
  expect(r.dispatch(...ctrl('k'))).toBe(false);
  // A key that cannot continue the chord cancels it and is swallowed.
  r.dispatch(...ctrl('x'));
  expect(r.dispatch(...plain('z'))).toBe(true);
  expect(notices).toEqual(['Chord cancelled', 'Chord cancelled']);
  expect(calls).toEqual(['kill']);
  // Enter completes `ctrl+x enter`.
  r.dispatch(...ctrl('x'));
  r.dispatch('', {...base, return: true});
  expect(calls).toEqual(['kill', 'queue']);
});
test('a chord prefix only counts when some active registration handles a chord starting with it', () => {
  const {router: r} = router([{Chat: {'chat:cycleMode': () => {}}}]);
  // Nothing handles ctrl+x chords here, so Ctrl+X is not swallowed (dialogs use it as a plain key).
  expect(r.dispatch(...ctrl('x'))).toBe(false);
  expect(r.pending).toBe('');
});
test('user keybindings: override, null unbinds, command: bindings and chords', () => {
  const keymap = buildKeymap(
    JSON.stringify({
      bindings: [
        {context: 'Chat', bindings: {'ctrl+e': 'chat:externalEditor', 'ctrl+s': null, 'ctrl+k': 'command:/model'}},
        {context: 'Select', bindings: {'ctrl+j': 'select:next'}},
      ],
    }),
  );
  expect(keymap.warnings).toEqual([]);
  const get = (context: 'Chat' | 'Select', keys: string) => {
    const chord = parseChord(keys);
    return chord.ok ? lookup(keymap, context, chord.value) : 'parse-error';
  };
  expect(get('Chat', 'ctrl+e')).toBe('chat:externalEditor');
  expect(get('Chat', 'ctrl+g')).toBe('chat:externalEditor'); // defaults stay unless unbound
  expect(get('Chat', 'ctrl+s')).toBeUndefined();
  expect(get('Chat', 'ctrl+k')).toBe('command:/model');
  expect(get('Select', 'ctrl+j')).toBe('select:next');
  // The router runs `command:<name>` through the host sink.
  const commands: string[] = [];
  const instance = new KeyRouter({keymap: () => keymap, onCommand: name => void commands.push(name)});
  instance.register({active: true, handlers: {Chat: {'chat:cycleMode': () => {}}}});
  instance.dispatch(...ctrl('k'));
  expect(commands).toEqual(['model']);
});
test('validation: invalid JSON, bad modifier, spaced modifier, unknown context/action, reserved and duplicate keys', () => {
  expect(buildKeymap('{nope').warnings[0]).toContain('not valid JSON');
  expect(buildKeymap('[]').warnings[0]).toContain('"bindings"');
  const keymap = buildKeymap(
    JSON.stringify({
      bindings: [
        {
          context: 'Chat',
          bindings: {
            'hyper+k': 'chat:undo',
            'ctrl+ k': 'chat:undo',
            'ctrl+c': 'chat:undo',
            'ctrl+h': 'chat:undo',
            'ctrl+q': 'chat:doesNotExist',
            'ctrl+y': 7,
            'ctrl+e': 'chat:undo',
            'Ctrl+E': 'chat:stash',
            'ctrl+w': 'command:',
          },
        },
        {context: 'Nowhere', bindings: {a: 'x'}},
        {bindings: {}},
        {context: 'Chat', bindings: []},
      ],
    }),
  );
  const joined = keymap.warnings.join('\n');
  expect(joined).toContain('Unknown modifier "hyper"');
  expect(joined).toContain('space follows');
  expect(joined).toContain('"ctrl+c" is reserved');
  expect(joined).toContain('"ctrl+h" is reserved');
  expect(joined).toContain('unknown action "chat:doesNotExist"');
  expect(joined).toContain('must be a string or null');
  expect(joined).toContain('bound more than once');
  expect(joined).toContain('needs a command name');
  expect(joined).toContain('unknown context "Nowhere"');
  expect(joined).toContain('"context" must be a string');
  expect(joined).toContain('"bindings" must be an object');
  // Valid entries and every default still apply.
  const chord = parseChord('ctrl+e');
  expect(chord.ok && lookup(keymap, 'Chat', chord.value)).toBe('chat:stash'); // later duplicate wins
  const ctrlC = parseChord('ctrl+c');
  expect(ctrlC.ok && lookup(keymap, 'Chat', ctrlC.value)).toBeUndefined();
  const global = parseChord('ctrl+c');
  expect(global.ok && lookup(keymap, 'Global', global.value)).toBe('app:interrupt');
});
test('reserved keys keep their meaning whatever the user file says', () => {
  const keymap = buildKeymap(
    JSON.stringify({
      bindings: [{context: 'Global', bindings: {'ctrl+c': 'app:toggleTodos', 'ctrl+d': null, 'ctrl+[': 'app:exit'}}],
    }),
  );
  expect(keymap.warnings).toHaveLength(3);
  const calls: string[] = [];
  const instance = new KeyRouter({keymap: () => keymap});
  instance.register({
    active: true,
    handlers: {
      Global: {'app:interrupt': () => void calls.push('interrupt'), 'app:exit': () => void calls.push('exit')},
    },
  });
  instance.dispatch(...ctrl('c'));
  instance.dispatch(...ctrl('d'));
  expect(calls).toEqual(['interrupt', 'exit']);
});
test('help columns come from the keymap, follow remaps and leave out unbound and unimplemented keys', () => {
  const columns = shortcutColumns(defaultKeymap(), {efforts: true, mac: true});
  const flat = columns.flat().join('\n');
  expect(flat).toContain('shift+tab to cycle modes');
  expect(flat).toContain('opt+p to switch model');
  expect(flat).toContain('ctrl+shift+_ to undo');
  expect(flat).toContain('shift+↑/↓ to change effort');
  expect(flat).toContain('ctrl+v to paste image');
  expect(flat).toContain('ctrl+b to background task');
  for (const missing of ['fast', 'thinking']) expect(flat).not.toContain(missing);
  expect(shortcutColumns(defaultKeymap(), {efforts: false, mac: false}).flat().join('\n')).not.toContain('effort');
  expect(shortcutColumns(defaultKeymap(), {efforts: false, mac: false}).flat().join('\n')).toContain(
    'alt+p to switch model',
  );
  const remapped = buildKeymap(
    JSON.stringify({bindings: [{context: 'Chat', bindings: {'ctrl+s': null, 'ctrl+e': 'chat:stash', 'alt+p': null}}]}),
  );
  const text = shortcutColumns(remapped, {efforts: true, mac: false}).flat().join('\n');
  expect(text).toContain('ctrl+e to stash prompt');
  expect(text).not.toContain('switch model');
});
test('template lists every default as $docs notes, binds nothing and is itself valid', () => {
  const template = keybindingsTemplate();
  const parsed = JSON.parse(template) as {
    $docs: string[];
    bindings: {context: string; $docs: string[]; bindings: object}[];
  };
  expect(parsed.$docs.length).toBeGreaterThan(0);
  const documented = parsed.bindings.flatMap(block => block.$docs);
  expect(documented.length).toBe(DEFAULT_BINDINGS.length);
  expect(documented.join('\n')).toContain('chat:killAgents');
  expect(parsed.bindings.every(block => Object.keys(block.bindings).length === 0)).toBe(true);
  expect(buildKeymap(template).warnings).toEqual([]);
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});
const tempHome = () => {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-keys-'));
  dirs.push(dir);
  return dir;
};
test('keybindings.json lives under the (temporary) HOME, is created from the template and loads without warnings', () => {
  const home = tempHome();
  const path = keybindingsPath(home);
  expect(path).toBe(join(home, '.cosmew', 'keybindings.json'));
  expect(loadKeybindings(path).warnings).toEqual([]); // missing file = defaults
  expect(ensureKeybindingsFile(path)).toBe(true);
  expect(ensureKeybindingsFile(path)).toBe(false);
  expect(loadKeybindings(path).warnings).toEqual([]);
});
test('an existing Claude CLI keybindings file is accepted as a compatibility source', () => {
  const home = tempHome();
  const claudePath = join(home, '.claude', 'keybindings.json');
  mkdirSync(join(home, '.claude'), {recursive: true});
  writeFileSync(claudePath, JSON.stringify({bindings: []}));
  expect(keybindingsPath(home)).toBe(claudePath);
  expect(loadKeybindings(keybindingsPath(home)).warnings).toEqual([]);
});
test('an existing legacy keybindings file is reused before creating a Cosmew file', () => {
  const home = tempHome();
  const legacyPath = join(home, '.futryn', 'keybindings.json');
  mkdirSync(join(home, '.futryn'), {recursive: true});
  writeFileSync(legacyPath, JSON.stringify({bindings: []}));
  expect(keybindingsPath(home)).toBe(legacyPath);
});
test('hot reload: editing the file swaps the bindings, warnings are reported once and logged, deleting restores defaults', async () => {
  const home = tempHome();
  const path = keybindingsPath(home);
  mkdirSync(join(home, '.cosmew'), {recursive: true});
  const store = new KeymapStore();
  const warnings: string[][] = [];
  let reloads = 0;
  const stop = watchKeybindings({
    path,
    store,
    intervalMs: 20,
    logPath: keybindingsLogPath(home),
    onWarnings: list => warnings.push([...list]),
    onReload: () => reloads++,
  });
  const waitFor = async (check: () => boolean) => {
    const end = Date.now() + 3000;
    while (!check() && Date.now() < end) await Bun.sleep(10);
    expect(check()).toBe(true);
  };
  try {
    const stash = parseChord('ctrl+s');
    const custom = parseChord('ctrl+e');
    if (!stash.ok || !custom.ok) throw new Error('parse');
    expect(lookup(store.get(), 'Chat', stash.value)).toBe('chat:stash');
    writeFileSync(
      path,
      JSON.stringify({bindings: [{context: 'Chat', bindings: {'ctrl+e': 'chat:stash', 'ctrl+s': null}}]}),
    );
    await waitFor(() => lookup(store.get(), 'Chat', custom.value) === 'chat:stash');
    expect(lookup(store.get(), 'Chat', stash.value)).toBeUndefined();
    expect(warnings).toEqual([]);
    // Broken file: defaults are back and the problem is reported once.
    writeFileSync(path, '{ not json, and a longer body so the size changes');
    await waitFor(() => warnings.length === 1);
    expect(warnings[0]![0]).toContain('not valid JSON');
    expect(lookup(store.get(), 'Chat', stash.value)).toBe('chat:stash');
    await Bun.sleep(80);
    expect(warnings).toHaveLength(1);
    const log = await Bun.file(keybindingsLogPath(home)).text();
    expect(log).toContain('not valid JSON');
    rmSync(path);
    await waitFor(() => store.get().warnings.length === 0);
    expect(lookup(store.get(), 'Chat', custom.value)).toBeUndefined();
    expect(reloads).toBeGreaterThanOrEqual(2);
  } finally {
    stop();
  }
});

test('DiffPanel publishes app:cycleDiffBase for Ctrl+X B and keeps the previous alias', () => {
  expect(
    DEFAULT_BINDINGS.find(entry => entry.context === 'DiffPanel' && entry.action === 'app:cycleDiffBase')?.keys,
  ).toEqual(['ctrl+x b']);
  expect(DEFAULT_BINDINGS.some(entry => entry.context === 'DiffPanel' && entry.action === 'diff:changeBase')).toBe(
    true,
  );
});
