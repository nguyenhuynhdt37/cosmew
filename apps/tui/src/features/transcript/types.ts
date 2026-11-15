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
  errorText?: string;
  durationMs?: number;
  reasoning?: string;
  reasoningExpanded?: boolean;
}

export interface ToolExecutionSummary {
  call: ToolCall;
  status: 'running' | 'completed' | 'denied' | 'failed' | 'not-implemented';
  expanded?: boolean;
  note?: string;
}

/** Một dòng nội tuyến mờ kiểu OpenCode: `⚙ tên-tool  {args}  — ghi chú`. */
