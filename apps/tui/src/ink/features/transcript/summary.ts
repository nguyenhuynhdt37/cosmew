import type {ToolCall, ToolResult} from '@cosmew/contracts';
import {isFileChangeTool} from '@cosmew/contracts';
import {diffStats, plural} from '../../ui/diff';
import {changeReceipt} from '../diff/logic';
import {toolDisplay} from './logic';

/** What a tool call counts as in the merged one-line summary of the normal transcript. */
export type ToolCategory = 'edit' | 'search' | 'read' | 'list' | 'shell' | 'other';

const LIST = new Set(['ls', 'tree', 'dir']);
const READ = new Set(['cat', 'head', 'tail', 'bat']);
const SEARCH = new Set(['grep', 'rg', 'find', 'fd', 'ag']);

/**
 * `ls -la` counts as "Listed 1 directory" (reference L01), `cat a.txt` as a read, `rg x` as a search. Only a simple
 * command (no pipe, list, redirect or substitution) is reclassified; everything else is "Ran N shell commands".
 */
export function categorize(call: ToolCall): ToolCategory {
  if (isFileChangeTool(call.name)) return 'edit';
  if (call.name === 'read') return 'read';
  if (call.name === 'glob' || call.name === 'grep') return 'search';
  if (call.name !== 'exec_command' && call.name !== 'write_stdin') return 'other';
  const cmd = String((call.input as {cmd?: unknown} | null)?.cmd ?? '').trim();
  if (!cmd || /[|;&<>`$()\n]/.test(cmd)) return 'shell';
  const word = cmd.split(/\s+/)[0]!.replace(/^.*\//, '');
  return LIST.has(word) ? 'list' : READ.has(word) ? 'read' : SEARCH.has(word) ? 'search' : 'shell';
}

export type ToolSegment =
  {kind: 'single'; callId: string} | {kind: 'summary'; callIds: string[]; text: string; running: boolean};

export interface SegmentContext {
  calls: ReadonlyMap<string, ToolCall>;
  results: ReadonlyMap<string, ToolResult>;
  live: boolean;
  /** Tools to show one by one even in the merged view (the focused/expanded ones) or every tool (detailed mode). */
  isolated: (callId: string) => boolean;
}

/** Whether a call must keep its own `⏺ Name(arg)` entry: refusals, errors with a reason, and tools with a body. */
function standsAlone(call: ToolCall, result: ToolResult | undefined, live: boolean, category: ToolCategory): boolean {
  if (category === 'other') return true;
  const display = toolDisplay(call, result, live);
  if (display.status === 'denied') return true;
  if (display.status === 'stopped') return true;
  if (display.status === 'error') {
    // `Ran 1 shell command · 1 failed` is only honest when the exit code was the whole story.
    return category !== 'shell' || display.lines.length > 1;
  }
  return false;
}

function stats(result: ToolResult | undefined) {
  return changeReceipt(result).changes.reduce(
    (total, change) => {
      const one = diffStats(change.diff);
      return {added: total.added + one.added, removed: total.removed + one.removed};
    },
    {added: 0, removed: 0},
  );
}

/** `Listed 1 directory`, `Ran 2 shell commands · 1 failed`, `Made 2 edits +3 -1, read 2 files`. */
export function summaryText(
  items: readonly {call: ToolCall; result?: ToolResult; failed: boolean}[],
  running: boolean,
): string {
  const count: Record<ToolCategory, number> = {edit: 0, search: 0, read: 0, list: 0, shell: 0, other: 0};
  let added = 0,
    removed = 0,
    failed = 0;
  for (const item of items) {
    count[categorize(item.call)]++;
    if (item.failed) failed++;
    if (categorize(item.call) === 'edit') {
      const one = stats(item.result);
      added += one.added;
      removed += one.removed;
    }
  }
  const words = running
    ? {edit: 'Making', search: 'Searching for', read: 'Reading', list: 'Listing', shell: 'Running'}
    : {edit: 'Made', search: 'Searched for', read: 'Read', list: 'Listed', shell: 'Ran'};
  const clauses = [
    count.edit ? `${words.edit} ${plural(count.edit, 'edit')} +${added} -${removed}` : '',
    count.search ? `${words.search} ${plural(count.search, 'pattern')}` : '',
    count.read ? `${words.read} ${plural(count.read, 'file')}` : '',
    count.list ? `${words.list} ${count.list} ${count.list === 1 ? 'directory' : 'directories'}` : '',
    count.shell ? `${words.shell} ${plural(count.shell, 'shell command')}` : '',
  ].filter(Boolean);
  const text = clauses.map((clause, index) => (index === 0 ? clause : clause[0]!.toLowerCase() + clause.slice(1)));
  return `${text.join(', ')}${running ? '…' : ''}${failed ? ` · ${failed} failed` : ''}`;
}

/**
 * Splits one turn's consecutive tool calls into merged summary lines and standalone entries (normal transcript view).
 * A single successful edit/write is standalone (it carries its diff); two or more merge into `Made N edits`.
 */
export function segmentTools(callIds: readonly string[], context: SegmentContext): ToolSegment[] {
  const present = callIds.filter(id => context.calls.has(id));
  const mergeable = present.filter(id => {
    const call = context.calls.get(id)!;
    const result = context.results.get(id);
    return (
      categorize(call) === 'edit' &&
      !!result &&
      !context.isolated(id) &&
      !standsAlone(call, result, context.live, 'edit')
    );
  });
  const mergeEdits = mergeable.length > 1;
  const segments: ToolSegment[] = [];
  let run: string[] = [];
  const close = () => {
    if (!run.length) return;
    const items = run.map(id => {
      const call = context.calls.get(id)!;
      const result = context.results.get(id);
      const status = toolDisplay(call, result, context.live).status;
      return {call, result, failed: status === 'error'};
    });
    const running = items.some(item => !item.result) && context.live;
    segments.push({kind: 'summary', callIds: run, text: summaryText(items, running), running});
    run = [];
  };
  for (const id of present) {
    const call = context.calls.get(id)!;
    const result = context.results.get(id);
    const category = categorize(call);
    const alone =
      context.isolated(id) ||
      standsAlone(call, result, context.live, category) ||
      (category === 'edit' && !mergeEdits) ||
      (category === 'edit' && !result);
    if (alone) {
      close();
      segments.push({kind: 'single', callId: id});
    } else run.push(id);
  }
  close();
  return segments;
}
