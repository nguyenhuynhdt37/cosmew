import {DEFAULT_BINDINGS, type KeyContext} from './defaults';
import {chordsFor, type Keymap} from './keymap';
import {parseChord, displayChord} from './keystroke';

export interface HelpCapabilities {
  /** The active model advertises effort levels (shows `shift+↑/↓ to change effort`). */
  efforts: boolean;
  /** Option key is printed `opt` (macOS) rather than `alt`. */
  mac: boolean;
  transcriptItems?: boolean;
  vim?: boolean;
}
/**
 * Actions exposed by the shortcut source. Transcript parity entries register the legend here;
 * their shell behavior is wired separately by Tasks 3–6 of the transcript parity plan.
 */
export const IMPLEMENTED_ACTIONS: ReadonlySet<string> = new Set([
  'diff:focus',
  'diff:blur',
  'app:cycleDiffBase',
  'diff:nextFile',
  'diff:open',
  'diff:pageDown',
  'chat:cycleMode',
  'chat:modelPicker',
  'chat:undo',
  'chat:externalEditor',
  'chat:stash',
  'chat:imagePaste',
  'task:background',
  'chat:suspend',
  'chat:newline',
  'chat:queueSubmit',
  'chat:sendNow',
  'chat:killAgents',
  'chat:clearInput',
  'app:toggleTranscript',
  'app:toggleTodos',
  'history:search',
  'transcript:toggleShowAll',
  'transcript:focusPrevious',
  'transcript:focusNext',
  'transcript:toggleItem',
  'transcript:search',
  'transcript:nextMatch',
  'transcript:previousMatch',
  'scroll:halfPageUp',
  'scroll:halfPageDown',
  'scroll:fullPageUp',
  'scroll:fullPageDown',
  'scroll:lineUp',
  'scroll:lineDown',
  'scroll:top',
  'scroll:bottom',
]);
interface Line {
  column: 0 | 1 | 2;
  /** Fixed text (not a key action), or an action whose current key prefixes `text`. */
  fixed?: string;
  context?: KeyContext;
  action?: string;
  text?: string;
  needs?: 'efforts' | 'transcriptItems';
  /** Help spelling of the default key when the terminal key differs from the doc (Ctrl+_ is typed with Shift). */
  alias?: Record<string, string>;
}
const LINES: readonly Line[] = [
  {column: 0, fixed: '! for shell mode'},
  {column: 0, fixed: '/ for commands'},
  {column: 0, fixed: '@ for file paths'},
  {
    column: 0,
    context: 'Transcript',
    action: 'transcript:focusPrevious',
    text: 'previous activity',
    needs: 'transcriptItems',
  },
  {column: 0, context: 'Transcript', action: 'transcript:focusNext', text: 'next activity', needs: 'transcriptItems'},
  {
    column: 0,
    context: 'Transcript',
    action: 'transcript:toggleItem',
    text: 'toggle activity',
    needs: 'transcriptItems',
  },
  {column: 1, fixed: 'esc esc to clear input'},
  {column: 1, context: 'Chat', action: 'chat:cycleMode', text: 'to cycle modes'},
  {column: 1, fixed: 'shift+↑/↓ to change effort', needs: 'efforts'},
  {column: 1, context: 'Global', action: 'app:toggleTranscript', text: 'to see full transcript'},
  {column: 1, context: 'Global', action: 'app:toggleTodos', text: 'to toggle tasks'},
  {column: 1, fixed: '\\ then enter for newline'},
  {column: 2, context: 'Chat', action: 'chat:undo', text: 'to undo', alias: {'ctrl+_': 'ctrl+shift+_'}},
  {column: 2, context: 'Chat', action: 'chat:suspend', text: 'to suspend'},
  {column: 2, context: 'Chat', action: 'chat:modelPicker', text: 'to switch model'},
  {column: 2, context: 'Chat', action: 'chat:stash', text: 'to stash prompt'},
  {column: 2, context: 'Chat', action: 'chat:externalEditor', text: 'to edit in $EDITOR'},
  {column: 2, context: 'Chat', action: 'chat:imagePaste', text: 'to paste image'},
  {column: 2, context: 'Chat', action: 'task:background', text: 'to background task'},
  {column: 2, fixed: '/keybindings to customize'},
];
/** Shortcut table of `?` and `/help`, column-major. Lines of unbound or unimplemented keys are left out. */
export function shortcutColumns(keymap: Keymap, capabilities: HelpCapabilities): string[][] {
  const columns: string[][] = [[], [], []];
  for (const line of LINES) {
    if (line.needs && !capabilities[line.needs]) continue;
    if (capabilities.vim && line.fixed?.startsWith('esc esc')) continue;
    if (line.fixed) {
      const label = capabilities.vim && line.column === 0 ? `Insert ${line.fixed}` : line.fixed;
      columns[line.column]!.push(label);
      continue;
    }
    if (!IMPLEMENTED_ACTIONS.has(line.action!)) continue;
    const chord = chordsFor(keymap, line.context!, line.action!)[0];
    if (!chord) continue;
    const parsed = parseChord(chord);
    let label = parsed.ok ? displayChord(parsed.value) : chord;
    label = line.alias?.[label] ?? label;
    if (capabilities.mac) label = label.replace(/\balt\+/g, 'opt+');
    columns[line.column]!.push(`${label} ${line.text}`);
  }
  if (capabilities.vim) {
    const label = (token: string) => {
      const action = `vim:${token}`;
      const defaults = DEFAULT_BINDINGS.find(entry => entry.action === action)?.keys ?? [];
      const chords = chordsFor(keymap, 'Vim', action);
      const chord = chords.find(key => !defaults.includes(key)) ?? chords[0];
      return chord?.replace(/^shift\+([a-z])$/, (_, letter: string) => letter.toUpperCase());
    };
    const groups = [
      [['escape'], 'leave mode'],
      [['enter'], 'submit'],
      [['?', '/'], 'help / history'],
      [['h', 'j', 'k', 'l'], 'move'],
      [['w', 'b', 'e', 'W', 'B', 'E'], 'words'],
      [['0', '^', '$', 'g', 'G', '%'], 'line / bracket'],
      [['space', 'backspace'], 'across lines'],
      [['f', 'F', 't', 'T', ';', ','], 'find / repeat'],
      [['d', 'c', 'y'], 'operator'],
      [['i', 'a', 'I', 'A', 'o', 'O'], 'insert'],
      [['x', 'X'], 'delete character'],
      [['D', 'C', 'Y', 's', 'S', 'R'], 'edit shortcuts'],
      [['p', 'P'], 'put'],
      [['u', 'ctrl+r', '.'], 'undo / redo / repeat'],
      [['r', '~', 'U', 'J'], 'replace / case / join'],
      [['v', 'V'], 'visual'],
      [['<', '>'], 'indent'],
      [['"', "'", '`', '(', ')', '[', ']', '{', '}'], 'objects'],
      [['1', '2', '3', '4', '5', '6', '7', '8', '9'], 'counts'],
    ] as const;
    groups.forEach(([tokens, description], index) => {
      const keys = tokens.map(label).filter(Boolean);
      if (keys.length) columns[index % columns.length]!.push(`${keys.join(' ')} ${description}`);
    });
  }
  return columns;
}

/** B3's transcript legend; prefer its displayed aliases only while they remain bound. */
export function transcriptLegend(keymap: Keymap, editorName = 'editor'): string[] {
  const label = (action: string, preferred?: readonly string[], context: KeyContext = 'Transcript') => {
    const chords = chordsFor(keymap, context, action);
    const shown = preferred?.filter(chord => chords.includes(chord));
    return (shown?.length ? shown : chords).map(chord => {
      const parsed = parseChord(chord);
      return (parsed.ok ? displayChord(parsed.value) : chord).replace(/^shift\+([a-z])$/, (_, letter: string) =>
        letter.toUpperCase(),
      );
    });
  };
  const keys = (action: string, preferred?: readonly string[]) => label(action, preferred).join('/') || 'unbound';
  const pair = (a: string, b: string, ap: string[], bp: string[]) =>
    [...label(a, ap), ...label(b, bp)].join('/') || 'unbound';
  const half = pair('scroll:halfPageUp', 'scroll:halfPageDown', ['ctrl+u'], ['ctrl+d']);
  return [
    `${keys('transcript:exit', ['q'])}/${label('app:toggleTranscript', undefined, 'Global').join('/') || 'unbound'} to exit`,
    `${keys('transcript:help')} to close`,
    `${[...label('scroll:lineUp', ['up']), ...label('scroll:lineDown', ['down']), ...label('scroll:lineDown', ['j']), ...label('scroll:lineUp', ['k'])].filter((key, at, all) => all.indexOf(key) === at).join('/')} to scroll`,
    `${half === 'ctrl+u/ctrl+d' ? 'ctrl+u/d' : half} to move half a page`,
    `${pair('scroll:fullPageDown', 'scroll:fullPageUp', ['space'], ['b'])} to move a page`,
    `${pair('scroll:top', 'scroll:bottom', ['g'], ['shift+g'])} to go to top/bottom`,
    `${pair('transcript:previousPrompt', 'transcript:nextPrompt', ['{'], ['}'])} to jump between prompts`,
    `${keys('transcript:search')} to search`,
    `${pair('transcript:nextMatch', 'transcript:previousMatch', ['n'], ['shift+n'])} to cycle matches`,
    `${keys('transcript:dumpScrollback')} to print to scrollback`,
    `${keys('transcript:openEditor')} to open in ${editorName}`,
  ];
}
