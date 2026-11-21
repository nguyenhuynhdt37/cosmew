import {SLASH_COMMANDS} from '@cosmew/sdk';
import {keymapStore, shortcutColumns} from '../../hooks/keymap';
/**
 * Shortcut table of `/help` and of the `?` footer (spec 2/7), column-major as drawn. It is generated from the central
 * keymap (user remaps included) and lists only keys that work in this shell: image paste, fast mode and the
 * extended-thinking toggle have no backend, so they are left out.
 */
export function helpShortcutColumns(efforts = true, transcriptItems = false): readonly (readonly string[])[] {
  return shortcutColumns(keymapStore.get(), {efforts, transcriptItems, mac: process.platform === 'darwin'});
}
/** Default table (with effort), kept for callers that want a constant. */
export const HELP_SHORTCUT_COLUMNS: readonly (readonly string[])[] = helpShortcutColumns();
export const HELP_INTRO =
  'Cosmew understands your codebase, makes edits with your permission, and runs commands — right from your terminal.';
export const HELP_MORE = 'For more help: see the Cosmew documentation in the repository (docs/).';
/** Rows of the table; terminals narrower than three columns stack the columns one under another. */
export function shortcutRows(width: number, columnWidths: readonly number[] = [24, 35, 34]): string[] {
  const total = columnWidths.reduce((sum, w) => sum + w, 0);
  const columns = helpShortcutColumns();
  if (width < total + 4) return columns.flat();
  const height = Math.max(...columns.map(c => c.length));
  return Array.from({length: height}, (_, row) =>
    columns
      .map((column, at) => (column[row] ?? '').padEnd(columnWidths[at]!))
      .join('')
      .trimEnd(),
  );
}
/** Built-in commands for the `Commands` tab, in SDK order. */
export function commandRows() {
  return SLASH_COMMANDS.filter(c => c.help !== false).map(c => ({
    id: c.command,
    label: `${c.command}${c.aliases.length ? ` (${c.aliases.join(', ')})` : ''}`,
    description: c.description,
  }));
}
/** The `?` table: the same columns, without the effort line for a model that advertises no effort levels. */
export function footerShortcutColumns(efforts: boolean, transcriptItems = false): readonly (readonly string[])[] {
  return helpShortcutColumns(efforts, transcriptItems).map(column =>
    // The `?` table spells the newline key out (reference 02-shortcuts); /help abbreviates it.
    column.map(line => (line.startsWith('\\ then') ? `backslash (\\) then enter for newline` : line)),
  );
}
