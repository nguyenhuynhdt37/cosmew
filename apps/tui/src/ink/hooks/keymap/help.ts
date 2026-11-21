import type {KeyContext} from './defaults';
import {chordsFor, type Keymap} from './keymap';
import {parseChord, displayChord} from './keystroke';

export interface HelpCapabilities {
  /** The active model advertises effort levels (shows `shift+↑/↓ to change effort`). */
  efforts: boolean;
  /** Option key is printed `opt` (macOS) rather than `alt`. */
  mac: boolean;
}
/**
 * Actions exposed by the shortcut source. Transcript parity entries register the legend here;
 * their shell behavior is wired separately by Tasks 3–6 of the transcript parity plan.
 */
export const IMPLEMENTED_ACTIONS: ReadonlySet<string> = new Set([
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
  needs?: 'efforts';
  /** Help spelling of the default key when the terminal key differs from the doc (Ctrl+_ is typed with Shift). */
  alias?: Record<string, string>;
}
const LINES: readonly Line[] = [
  {column: 0, fixed: '! for shell mode'},
  {column: 0, fixed: '/ for commands'},
  {column: 0, fixed: '@ for file paths'},
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
    if (line.needs === 'efforts' && !capabilities.efforts) continue;
    if (line.fixed) {
      columns[line.column]!.push(line.fixed);
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
  return columns;
}
