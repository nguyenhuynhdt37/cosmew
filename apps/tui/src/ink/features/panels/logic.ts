/** Transcript lines a finished command leaves behind: `❯ /export` then `  ⎿  Export cancelled` (spec 7). */
export interface CommandResultLines {
  prompt: string;
  result: string[];
}
/** `⎿` continuation text of Claude Code's command result lines (two spaces, glyph, no-break space, two spaces). */
export const RESULT_PREFIX = '  ⎿ \u00a0';
export function commandResult(command: string, ...result: string[]): CommandResultLines {
  return {
    prompt: `❯ ${command}`,
    result: result.map((line, at) => (at === 0 ? `${RESULT_PREFIX}${line}` : `     ${line}`)),
  };
}
export const notImplementedResult = (command: string) => commandResult(command, 'Not implemented');
export const cancelledResult = (command: string, noun: string) => commandResult(command, `${noun} cancelled`);
export const closedResult = (command: string, noun: string) => commandResult(command, `Closed ${noun}`);
/** Status glyphs of `/mcp`: connected, needs sign-in, failed, not connected. */
export const MCP_GLYPH = {
  connected: '✔',
  'needs-auth': '⚠',
  failed: '✘',
  disabled: '◯',
  stopped: '◯',
  connecting: '…',
  reconnecting: '…',
} as const;
export type McpState = keyof typeof MCP_GLYPH;
export interface McpServerRow {
  name: string;
  state: McpState;
  tools?: number;
}
export const mcpRowText = (row: McpServerRow) =>
  `${MCP_GLYPH[row.state]} ${row.name}${row.tools == null ? '' : `  ${row.tools} ${row.tools === 1 ? 'tool' : 'tools'}`}`;
export interface RewindRow {
  id: string;
  prompt: string;
  detail: string;
}
/** Only durable SDK checkpoints are selectable; message history is not restore evidence. */
export function rewindRows(checkpoints: readonly import('@cosmew/contracts').CheckpointView[]): RewindRow[] {
  return checkpoints.map(checkpoint => ({
    id: checkpoint.id,
    prompt: (checkpoint.text || checkpoint.prompt).trim().replace(/\s+/g, ' ').slice(0, 110),
    detail: !checkpoint.restorable
      ? '⚠ No code restore'
      : checkpoint.fileChanges.length
        ? checkpoint.fileChanges.map(file => `${file.path} +${file.additions} -${file.deletions}`).join(' · ')
        : 'No code changes',
  }));
}
