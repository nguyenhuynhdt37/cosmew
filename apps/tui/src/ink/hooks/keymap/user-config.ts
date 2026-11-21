import {appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {DEFAULT_BINDINGS} from './defaults';
import {buildKeymap, type Keymap} from './keymap';
import type {KeymapStore} from './store';

/** User-level only: a workspace can never ship keybindings. HOME is honoured so tests use a temporary directory. */
export function keybindingsPath(home: string = process.env.HOME || homedir()): string {
  // Prefer the canonical Cosmew file, then preserve existing legacy/Claude files in place.
  for (const directory of ['.cosmew', '.futryn', '.hannes', '.claude']) {
    const path = join(home, directory, 'keybindings.json');
    try {
      statSync(path);
      return path;
    } catch {
      /* missing compatibility file */
    }
  }
  return join(home, '.cosmew', 'keybindings.json');
}
export function keybindingsLogPath(home: string = process.env.HOME || homedir()): string {
  return join(dirname(keybindingsPath(home)), 'debug', 'keybindings.log');
}
/** Read and validate the file. A missing file means defaults, without warnings. */
export function loadKeybindings(path: string): Keymap {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return buildKeymap();
    return {
      ...buildKeymap(),
      warnings: [
        `keybindings.json could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'}); defaults kept.`,
      ],
    };
  }
  return buildKeymap(text);
}
/** Write warnings to the debug log (best effort; never throws, never writes secrets: only the validation messages). */
export function logKeybindingWarnings(warnings: readonly string[], logPath: string): void {
  if (!warnings.length) return;
  try {
    mkdirSync(dirname(logPath), {recursive: true, mode: 0o700});
    appendFileSync(logPath, warnings.map(line => `${new Date().toISOString()} ${line}\n`).join(''), {mode: 0o600});
  } catch {
    // The notice on screen is the primary report.
  }
}
export interface WatchOptions {
  path: string;
  store: KeymapStore;
  /** Called with warnings of a (re)load, only when they differ from the previous load. */
  onWarnings?: (warnings: readonly string[]) => void;
  onReload?: () => void;
  logPath?: string;
  intervalMs?: number;
}
function signature(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}
/** Load once, then poll the mtime (no fs.watch: editors replace the file by rename). Returns a stop function. */
export function watchKeybindings(options: WatchOptions): () => void {
  let last = '';
  let lastWarnings = '';
  const apply = () => {
    const keymap = loadKeybindings(options.path);
    options.store.set(keymap);
    const joined = keymap.warnings.join('\n');
    if (joined !== lastWarnings) {
      lastWarnings = joined;
      if (keymap.warnings.length) {
        if (options.logPath) logKeybindingWarnings(keymap.warnings, options.logPath);
        options.onWarnings?.(keymap.warnings);
      }
    }
  };
  const check = () => {
    const now = signature(options.path);
    if (now === last) return;
    const first = last === '';
    last = now;
    apply();
    if (!first) options.onReload?.();
  };
  check();
  const timer = setInterval(check, options.intervalMs ?? 1000);
  (timer as {unref?: () => void}).unref?.();
  return () => clearInterval(timer);
}
/** Template for `/keybindings`: no active bindings, every default listed in `$docs` so nothing is changed by accident. */
export function keybindingsTemplate(): string {
  const contexts = [...new Set(DEFAULT_BINDINGS.map(entry => entry.context))];
  const blocks = contexts.map(context => ({
    context,
    $docs: DEFAULT_BINDINGS.filter(entry => entry.context === context).map(
      entry =>
        `${entry.keys.join(' | ')}: ${entry.action} - ${entry.description}${entry.action === 'vim:escape' ? ' (Esc is reserved in Vim)' : ''}`,
    ),
    bindings: {},
  }));
  return `${JSON.stringify(
    {
      $docs: [
        'Cosmew keybindings. Add "key": "action" pairs to a context; "key": null removes a default.',
        'Keys: ctrl+, shift+, alt+ (opt+, meta+), cmd+; chords are separated by a space (ctrl+x ctrl+k).',
        'Not rebindable: ctrl+c, ctrl+d, ctrl+m, ctrl+[, ctrl+i, ctrl+h. "command:<name>" runs a slash command.',
        'The file reloads when it changes. Problems are shown once and the defaults stay in effect.',
      ],
      bindings: blocks,
    },
    null,
    2,
  )}\n`;
}
/** Create the file from the template when it does not exist; returns whether it was created. */
export function ensureKeybindingsFile(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch {
    mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    writeFileSync(path, keybindingsTemplate(), {mode: 0o600, flag: 'wx'});
    return true;
  }
}
