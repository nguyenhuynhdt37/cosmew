import {
  FutrynError,
  executionEventDataSchema,
  turnStateSchema,
  type ConversationEvent,
  type DurableTurn,
  type Message,
  type StoredMessage,
  type ToolResult,
} from '@cosmew/contracts';

/**
 * Pure reconstruction of a conversation from its execution journal (ADR 0030/0033). Nothing here
 * touches the database, invokes a tool or restores a grant: the journal is evidence, and anything
 * it cannot prove is presented as unknown or not executed.
 */

/** One `execution_turns` row. */
export interface TurnRow {
  id: string;
  user_revision: number;
  end_revision: number | null;
  state: string;
  owner_pid: number;
  owner: string;
}

/** One `conversation_events` row. */
export interface EventRow {
  seq: number;
  turn_id: string;
  at: string;
  data: string;
}

/** Undelivered steering of finished turns, in acceptance order, until a later turn carries it. */
export type PendingInputs = Map<string, Message>;

const INCOMPLETE_PREFIX =
  '[incomplete response: the stream ended before the provider completed it; not a final answer]\n';
const UNKNOWN_OUTCOME =
  '[unknown: interrupted execution] Intent was recorded but no result was confirmed. Inspect current filesystem state; do not replay or reuse an old approval.';
const NOT_EXECUTED =
  '[not executed] The turn ended before Cosmew dispatched this call. A new call requires current policy and fresh revalidation.';

const corrupt = () => new FutrynError('STORAGE');
const isLive = (state: string) => state === 'pending' || state === 'running';

/** Attach every journal event to its turn. Sequence numbers must be gapless and every event owned. */
export function groupEvents(rows: TurnRow[], records: EventRow[]): DurableTurn[] {
  const turns: DurableTurn[] = rows.map(row => ({
    id: row.id,
    userRevision: row.user_revision,
    state: turnStateSchema.parse(row.state),
    events: [],
  }));
  const byId = new Map(turns.map(turn => [turn.id, turn]));
  for (const [index, record] of records.entries()) {
    const turn = byId.get(record.turn_id);
    if (record.seq !== index + 1 || !turn) throw corrupt();
    const event: ConversationEvent = {
      seq: record.seq,
      turnId: record.turn_id,
      at: record.at,
      data: executionEventDataSchema.parse(JSON.parse(record.data)),
    };
    turn.events.push(event);
  }
  return turns;
}

/**
 * Rebuild the model-visible history: legacy (pre-journal) messages interleaved by revision with the
 * reconstruction of each journaled turn. Also returns input that is still waiting for a turn.
 */
export function reconstructConversation(
  rows: TurnRow[],
  turns: DurableTurn[],
  legacy: StoredMessage[],
  retracted: ReadonlySet<string> = new Set(),
): {messages: Message[]; pendingInput: PendingInputs} {
  const messages: Message[] = [];
  const pendingInput: PendingInputs = new Map();
  let cursor = 0;
  const takeLegacy = () => {
    const {revision: _revision, state: _state, ...message} = legacy[cursor++]!;
    messages.push(message);
  };

  for (const [index, row] of rows.entries()) {
    while (cursor < legacy.length && legacy[cursor]!.revision < row.user_revision) takeLegacy();

    const turn = turns[index]!;
    validateTurn(turn, row, pendingInput);
    messages.push(...reconstructTurn(turn, pendingInput, retracted));

    // Legacy messages covered by this turn are replaced by its reconstruction.
    const end = row.end_revision ?? (rows[index + 1]?.user_revision ?? Infinity) - 1;
    while (cursor < legacy.length && legacy[cursor]!.revision <= end) cursor++;
  }
  while (cursor < legacy.length) takeLegacy();
  return {messages, pendingInput};
}

/** Integrity of one turn's events. Any violation means the journal cannot be trusted. */
export function validateTurn(turn: DurableTurn, row: TurnRow, pendingInput: PendingInputs): void {
  if (turn.events[0]?.data.type !== 'user.accepted') throw corrupt();
  if (row.user_revision < 1 || (row.end_revision !== null && row.end_revision < row.user_revision)) throw corrupt();

  const calls = new Map<string, string>();
  const intents = new Set<string>();
  const results = new Set<string>();
  const steers = new Set<string>();
  const requested = new Set<string>();
  const completed = new Set<string>();
  let finished = false;

  for (const [position, event] of turn.events.entries()) {
    const e = event.data;
    if (finished || !Number.isFinite(Date.parse(event.at))) throw corrupt();

    switch (e.type) {
      case 'user.accepted':
        if (position !== 0 || !isPlainUserMessage(e.message)) throw corrupt();
        if (e.carried?.some(id => !pendingInput.has(id))) throw corrupt();
        break;
      case 'user.steered':
        if (position === 0 || !isPlainUserMessage(e.message) || steers.has(e.steerId)) throw corrupt();
        steers.add(e.steerId);
        break;
      case 'model.requested':
        if (requested.has(e.stepId)) throw corrupt();
        requested.add(e.stepId);
        break;
      case 'model.completed':
        if (!requested.has(e.stepId) || completed.has(e.stepId)) throw corrupt();
        completed.add(e.stepId);
        break;
      case 'tool.call':
        if (calls.has(e.call.id)) throw corrupt();
        calls.set(e.call.id, e.call.name);
        break;
      case 'tool.intent':
        if (!calls.has(e.callId) || intents.has(e.callId) || results.has(e.callId)) throw corrupt();
        intents.add(e.callId);
        break;
      case 'tool.result':
        if (calls.get(e.result.callId) !== e.result.name || results.has(e.result.callId)) throw corrupt();
        results.add(e.result.callId);
        break;
      case 'turn.finished':
        if (e.state !== turn.state || isLive(e.state)) throw corrupt();
        finished = true;
        break;
    }
  }
  // A finished turn must end with turn.finished; a live one must not have it.
  if (finished === isLive(turn.state)) throw corrupt();
}

/**
 * Model-visible messages of one turn (Codex normalize + rollout reconstruction, ADR 0033):
 * - Steering is visible where the loop delivered it: before the next non-first model request.
 *   Undelivered steering of a finished turn becomes pending input for the next turn, not history.
 * - In `protocol: 2` requests, text is committed only by `model.completed` (Codex records an item at
 *   OutputItemDone). A superseded response's text (retry or preemption) is dropped; a turn that
 *   ended inside an unfinished response keeps it, labelled incomplete.
 * - Completed tool calls and confirmed results always stay; unresolved calls get explicit outcomes.
 */
export function reconstructTurn(
  turn: DurableTurn,
  pendingInput: PendingInputs,
  retracted: ReadonlySet<string> = new Set(),
): Message[] {
  const messages: Message[] = [];
  const segments = new ResponseSegments(messages);
  const steered: {steerId: string; message: Message}[] = [];
  let requests = 0;

  for (const {data: e} of turn.events) {
    switch (e.type) {
      case 'assistant.text':
        segments.addText(e.text);
        break;
      case 'user.accepted':
        // Input carried over from earlier turns opens this turn, before its own message.
        for (const id of e.carried ?? []) {
          messages.push(pendingInput.get(id)!);
          pendingInput.delete(id);
        }
        messages.push(e.message);
        break;
      case 'user.steered':
        if (!retracted.has(e.steerId)) steered.push({steerId: e.steerId, message: e.message});
        break;
      case 'tool.call':
        segments.add({role: 'assistant', content: '', toolCalls: [e.call]});
        break;
      case 'tool.result':
        segments.add(resultMessage(e.result));
        break;
      case 'model.completed':
        segments.commit();
        break;
      case 'model.requested':
        segments.close({superseded: true});
        segments.open({provisional: e.protocol === 2});
        // Steering is delivered before every request except the turn's first.
        if (requests++ > 0) messages.push(...steered.splice(0).map(s => s.message));
        break;
    }
  }
  segments.close({superseded: false});

  if (!isLive(turn.state)) {
    messages.push(...unresolvedCallMessages(turn));
    for (const s of steered) pendingInput.set(s.steerId, s.message);
  }
  return messages;
}

/** A finished turn answers every call without a confirmed result, explicitly and without replay. */
export function unresolvedCallMessages(turn: DurableTurn): Message[] {
  const attempted = new Set<string>();
  const resolved = new Set<string>();
  for (const {data} of turn.events) {
    if (data.type === 'tool.intent') attempted.add(data.callId);
    if (data.type === 'tool.result') resolved.add(data.result.callId);
  }
  return turn.events.flatMap(({data}) => {
    if (data.type !== 'tool.call' || resolved.has(data.call.id)) return [];
    const call = data.call;
    return [
      {
        role: 'tool' as const,
        toolCallId: call.id,
        toolName: call.name,
        content: attempted.has(call.id) ? UNKNOWN_OUTCOME : NOT_EXECUTED,
      },
    ];
  });
}

/**
 * Messages of one model response, kept or dropped as a unit. Text is buffered until the next tool
 * message or commit point. A provisional response (protocol 2) keeps its text only if it completed.
 */
class ResponseSegments {
  private text = '';
  private segment: Message[] = [];
  /** Text of the current response that is still provisional. */
  private provisionalText = '';
  private provisional = false;
  private committed = true;

  constructor(private readonly out: Message[]) {}

  /** A new model request starts a new response. */
  open({provisional}: {provisional: boolean}): void {
    this.provisional = provisional;
    this.committed = !provisional;
  }

  addText(text: string): void {
    this.text += text;
  }

  add(message: Message): void {
    this.flushText();
    this.segment.push(message);
  }

  /** `model.completed`: the response reached OutputItemDone; its text is history. */
  commit(): void {
    this.flushText();
    this.committed = true;
  }

  /**
   * Emit the response. Uncommitted text is dropped when a later request superseded it (retry or
   * preemption), or kept with an explicit "incomplete" label when the turn ended inside it. Tool
   * calls and results are always kept.
   */
  close({superseded}: {superseded: boolean}): void {
    this.flushText();
    if (this.committed || !this.provisionalText) {
      this.out.push(...this.segment);
    } else {
      this.out.push(...this.segment.filter(m => m.role !== 'assistant' || m.toolCalls));
      if (!superseded) this.out.push({role: 'assistant', content: INCOMPLETE_PREFIX + this.provisionalText});
    }
    this.segment = [];
    this.provisionalText = '';
    this.committed = true;
    this.provisional = false;
  }

  private flushText(): void {
    if (!this.text) return;
    this.segment.push({role: 'assistant', content: this.text});
    if (this.provisional) this.provisionalText += this.text;
    this.text = '';
  }
}

function isPlainUserMessage(message: Message): boolean {
  return message.role === 'user' && !message.toolCalls?.length && !message.toolCallId;
}

function resultMessage(result: ToolResult): Message {
  const content =
    result.status === 'ok'
      ? result.content || '(empty)'
      : `[${result.status}${result.code ? ': ' + result.code : ''}] ${result.content}`;
  return {role: 'tool', content, toolCallId: result.callId, toolName: result.name};
}
