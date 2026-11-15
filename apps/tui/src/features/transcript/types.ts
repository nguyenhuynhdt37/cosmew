import type { Message, ToolCall, Usage } from '@hannes/contracts';

export interface TranscriptItem {
  id: string;
  role: Message['role'];
  content: string;
  modelId?: string;
  accountAlias?: string;
  usage?: Usage | null;
  toolCalls?: ToolCall[];
  streaming?: boolean;
  errorText?: string;
  durationMs?: number;
  reasoning?: string;
  reasoningExpanded?: boolean;
}

export interface ToolExecutionSummary {
  call: ToolCall;
  status: 'completed' | 'denied' | 'not-implemented';
  expanded?: boolean;
  note?: string;
}

/** Một dòng nội tuyến mờ kiểu OpenCode: `⚙ tên-tool  {args}  — ghi chú`. */
