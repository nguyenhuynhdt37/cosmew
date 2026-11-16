import type {TranscriptItem} from '../../apps/tui/src/features/transcript/types';

/** Deterministic mixed history; includes long code, reasoning and command output. */
export function transcriptFixture(count: number): TranscriptItem[] {
  return Array.from({length: count}, (_, i) => {
    if (i % 2 === 0) return {id: `m${i}`, role: 'user', content: `Inspect module ${i}: Unicode 日本語 👩🏽‍💻 é`};
    const id = `call${i}`;
    return {
      id: `m${i}`,
      role: 'assistant',
      content: `## Result ${i}\n${'A readable **answer** with `code` and context. '.repeat(12)}\n\n\`\`\`ts\n${'const value = 42; // deterministic source\n'.repeat(12)}\`\`\``,
      reasoning: '**Inspecting**\n' + 'Reasoning summary. '.repeat(80),
      toolCalls: [{id, name: 'exec_command', input: {cmd: `test module${i}`}}],
      toolResults: [
        {callId: id, name: 'exec_command', status: 'ok', content: 'test output\n'.repeat(160), exitCode: 0},
      ],
    };
  });
}
