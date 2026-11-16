import {FutrynError} from '@futryn/contracts';
import type {CommandOutputChunk, Message, Selection, ToolCall, ToolResult, TurnReceipt} from '@futryn/contracts';
import type {SqliteConversations} from '@futryn/persistence';

/**
 * Persist a user shell invocation through the same execution journal as agent tools. The injected
 * invocation is the existing dispatcher; the journal stores evidence and never replays commands.
 */
export async function runUserShellCommand(options: {
  store: Pick<SqliteConversations, 'beginExecution' | 'recordExecution' | 'complete' | 'interrupt'>;
  sessionId: string;
  selection: Selection;
  callId: string;
  command: string;
  signal?: AbortSignal;
  onOutput?: (chunk: CommandOutputChunk) => void;
  invoke(call: ToolCall, signal?: AbortSignal, onOutput?: (chunk: CommandOutputChunk) => void): Promise<ToolResult>;
}): Promise<ToolResult> {
  const {store, sessionId, selection} = options;
  const receipt: TurnReceipt = {
    requestId: crypto.randomUUID(),
    accountId: selection.accountId,
    modelId: selection.modelId,
    kind: 'user-shell',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    outcome: 'pending',
    usage: null,
    context: null,
  };
  const call: ToolCall = {id: options.callId, name: 'exec_command', input: {cmd: options.command}};
  const revision = store.beginExecution(sessionId, {role: 'user', content: `!${options.command}`}, receipt);
  const steps: Message[] = [];
  let recordedResult: ToolResult | undefined;
  try {
    store.recordExecution(sessionId, receipt.requestId, {type: 'tool.call', call});
    steps.push({role: 'assistant', content: '', toolCalls: [call]});
    // Dispatch intent is not proof of permission or execution. An unconfirmed outcome recovers as unknown.
    store.recordExecution(sessionId, receipt.requestId, {
      type: 'tool.intent',
      callId: call.id,
      executionId: crypto.randomUUID(),
      capability: 'process.execute',
    });
    const result = await options.invoke(call, options.signal, options.onOutput);
    if (result.callId !== call.id || result.name !== call.name) throw new FutrynError('PROTOCOL');
    store.recordExecution(sessionId, receipt.requestId, {type: 'tool.result', result});
    recordedResult = result;
    const message: Message = {
      role: 'tool',
      toolCallId: call.id,
      toolName: call.name,
      content:
        result.status === 'ok'
          ? result.content || '(empty)'
          : `[${result.status}${result.code ? ': ' + result.code : ''}] ${result.content}`,
    };
    const succeeded = result.status === 'ok' && (result.exitCode === 0 || !!result.sessionId);
    receipt.finishedAt = new Date().toISOString();
    receipt.outcome = succeeded ? 'completed' : options.signal?.aborted ? 'cancelled' : 'failed';
    if (succeeded) store.complete(sessionId, revision, message, receipt, steps);
    else store.interrupt(sessionId, revision, receipt, [...steps, message]);
    return result;
  } catch (error) {
    receipt.finishedAt = new Date().toISOString();
    receipt.outcome = options.signal?.aborted ? 'cancelled' : 'failed';
    if (recordedResult)
      steps.push({role: 'tool', toolCallId: call.id, toolName: call.name, content: recordedResult.content});
    store.interrupt(sessionId, revision, receipt, steps);
    throw error;
  }
}
