import type { Message, ToolCall, ToolResult, Usage } from '@hannes/contracts';

export interface TranscriptItem {
  id: string;
  role: Message['role'];
  content: string;
  modelId?: string;
  accountAlias?: string;
  usage?: Usage | null;
  toolCalls?: ToolCall[];
  /** Results matched to `toolCalls` by call id; a call without a result is still running. */
  toolResults?: ToolResult[];
  streaming?: boolean;
  /** Live wait indicator, not provider reasoning or a claim that a tool has started. */
  awaitingModel?: boolean;
  errorText?: string;
  durationMs?: number;
  reasoning?: string;
  reasoningExpanded?: boolean;
  /**
   * What happened in this turn, in arrival order (ADR 0021). Text and reasoning parts hold their
   * own slice of the stream; a tools part names calls in `toolCalls`. Absent on old items, which
   * render from the flat fields instead.
   */
  parts?: TranscriptPart[];
}

export type TranscriptPart =
  | { kind: 'reasoning'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tools'; callIds: string[] };

/** One row under an `Explored` header, e.g. `Read routes.ts, service.ts`. */
export interface ExplorationRow {
  verb: string;
  target: string;
  /** Short outcome note such as `denied` or `partial`; none for a plain success. */
  note?: string;
  tone: 'ok' | 'muted' | 'error';
}

export interface ToolExecutionSummary {
  call: ToolCall;
  status: 'running' | 'completed' | 'denied' | 'failed' | 'not-implemented';
  expanded?: boolean;
  note?: string;
}

/** Một dòng nội tuyến mờ kiểu OpenCode: `⚙ tên-tool  {args}  — ghi chú`. */
