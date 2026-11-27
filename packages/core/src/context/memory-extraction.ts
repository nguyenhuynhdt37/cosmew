import {
  FutrynError,
  memoryWriteSchema,
  type MemoryInfo,
  type MemoryWrite,
  type Message,
  type ModelPort,
  type Selection,
  type Usage,
} from '@cosmew/contracts';

const MAX_EXTRACTION_INPUT_BYTES = 16 * 1024;
const MAX_EXTRACTED_MEMORIES = 3;
const DEFAULT_EXTRACTION_TIMEOUT_MS = 15_000;

export const AUTO_MEMORY_PROMPT = [
  'Extract at most 3 durable, non-obvious project or user memories from the recent conversation.',
  'Only save durable facts that cannot be trivially inferred from source code or git history:',
  '- user: user role, preferences, or workflow conventions',
  '- feedback: corrections or explicit rules the user gave for future turns',
  '- project: architectural decisions, constraints, or operational facts not documented in code',
  '- reference: pointers to external systems, dashboards, or issue trackers',
  'NEVER include secrets, API keys, passwords, bearer tokens, private keys, cookies, or raw .env values.',
  'Do not duplicate existing memories listed in the prompt. If nothing durable is worth saving, return {"memories": []}.',
  'Respond ONLY with a valid JSON object matching: {"memories": [{"name": "kebab-case-name", "type": "user|feedback|project|reference", "description": "short summary", "content": "concise markdown detail"}]}',
].join('\n');

const SENSITIVE_MEMORY_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{25,}\b/,
  /\bya29\.[0-9A-Za-z._-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key|password|passwd|db[_-]?pass)\s*[:=]\s*["']?[^\s"']{8,}/i,
];

/** Hard guard rejecting candidates that look like credentials, tokens, or secrets (ADR 0124). */
export function looksLikeSensitiveMemory(text: string): boolean {
  if (!text) return false;
  return SENSITIVE_MEMORY_PATTERNS.some(pattern => pattern.test(text));
}

function normalizeMemoryName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function extractJsonBlock(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();
  const objStart = trimmed.indexOf('{');
  const arrStart = trimmed.indexOf('[');
  const start = objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
  if (start === -1) return trimmed;
  const open = trimmed[start];
  const close = open === '[' ? ']' : '}';
  const end = trimmed.lastIndexOf(close);
  return end > start ? trimmed.slice(start, end + 1) : trimmed.slice(start);
}

/** Parse and strictly validate JSON candidates produced by the extraction model. */
export function parseExtractedMemories(raw: string): MemoryWrite[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonBlock(raw));
  } catch {
    return [];
  }
  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as {memories?: unknown}).memories)
      ? (parsed as {memories: unknown[]}).memories
      : [];
  const valid: MemoryWrite[] = [];
  const seenNames = new Set<string>();
  for (const item of items) {
    if (valid.length >= MAX_EXTRACTED_MEMORIES) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const rawName = typeof record.name === 'string' ? normalizeMemoryName(record.name) : '';
    const rawDescription =
      typeof record.description === 'string' ? record.description.replace(/[\r\n\x00-\x1f\x7f]+/g, ' ').trim() : '';
    const rawContent = typeof record.content === 'string' ? record.content.trim() : '';
    const checked = memoryWriteSchema.safeParse({
      name: rawName,
      type: record.type,
      description: rawDescription.slice(0, 300),
      content: rawContent.slice(0, 16384),
    });
    if (!checked.success || !checked.data.content) continue;
    if (seenNames.has(checked.data.name)) continue;
    seenNames.add(checked.data.name);
    valid.push(checked.data);
  }
  return valid;
}

export interface AutoMemoryExtractionOptions {
  model: ModelPort;
  selection: Selection;
  messages: readonly Message[];
  existing: readonly MemoryInfo[];
  redact?: (text: string) => string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onUsage?: (usage: Usage) => void;
}

export interface AutoMemoryExtractionResult {
  candidates: MemoryWrite[];
  rejectedSensitive: number;
  skippedExisting: number;
  usage?: Usage;
}

/**
 * Runs one bounded, tool-free extraction request after a completed chat turn when `memories.auto_extract = true`.
 * Rejects secret-bearing candidates and never overwrites existing user-authored memories with the same name.
 */
export async function extractAutoMemories(options: AutoMemoryExtractionOptions): Promise<AutoMemoryExtractionResult> {
  if (options.signal?.aborted) throw new FutrynError('CANCELLED');
  const redact = options.redact ?? ((text: string) => text);
  const conversational = options.messages
    .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content.trim().length > 0)
    .slice(-10);
  if (conversational.length < 2) return {candidates: [], rejectedSensitive: 0, skippedExisting: 0};

  // Build bounded transcript excerpt from newest messages backwards.
  const lines: string[] = [];
  let totalBytes = 0;
  for (let i = conversational.length - 1; i >= 0; i--) {
    const msg = conversational[i]!;
    const safeText = redact(msg.content).trim();
    if (!safeText) continue;
    const entry = `${msg.role.toUpperCase()}: ${safeText.slice(0, 3000)}`;
    const entryBytes = Buffer.byteLength(entry, 'utf8') + 2;
    if (totalBytes + entryBytes > MAX_EXTRACTION_INPUT_BYTES && lines.length > 0) break;
    lines.unshift(entry);
    totalBytes += entryBytes;
  }
  if (!lines.length) return {candidates: [], rejectedSensitive: 0, skippedExisting: 0};

  const existingSummary = options.existing
    .slice(0, 50)
    .map(m => `- ${m.name} (${m.type}): ${redact(m.description)}`)
    .join('\n');
  const promptText = [
    existingSummary ? `Existing memories (do not duplicate or overwrite):\n${existingSummary}\n` : '',
    'Recent conversation excerpt:',
    lines.join('\n\n'),
  ]
    .filter(Boolean)
    .join('\n');

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS;
  const timer = setTimeout(
    () => controller.abort(new DOMException('Auto-memory extraction timeout', 'TimeoutError')),
    timeoutMs,
  );
  const combinedSignal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try {
    let responseText = '';
    let reportedUsage: Usage | undefined;
    let completed = false;
    for await (const event of options.model.stream(
      {
        requestId: crypto.randomUUID(),
        modelId: options.selection.modelId,
        instructions: AUTO_MEMORY_PROMPT,
        messages: [{role: 'user', content: promptText}],
        tools: [],
        maxOutputTokens: 1024,
      },
      combinedSignal,
    )) {
      if (event.type === 'responseDiscarded') responseText = '';
      else if (event.type === 'textDelta') responseText += event.text;
      else if (event.type === 'completed') {
        completed = true;
        reportedUsage = event.usage;
      }
    }
    if (!completed) return {candidates: [], rejectedSensitive: 0, skippedExisting: 0};
    if (reportedUsage) options.onUsage?.(reportedUsage);
    const parsed = parseExtractedMemories(responseText);
    const existingNames = new Set(options.existing.map(m => m.name));
    const candidates: MemoryWrite[] = [];
    let rejectedSensitive = 0;
    let skippedExisting = 0;
    for (const candidate of parsed) {
      if (existingNames.has(candidate.name)) {
        skippedExisting++;
        continue;
      }
      const rawJoined = `${candidate.name}\n${candidate.description}\n${candidate.content}`;
      const redactedDesc = redact(candidate.description);
      const redactedContent = redact(candidate.content);
      const redactedMutated =
        redactedDesc !== candidate.description ||
        redactedContent !== candidate.content ||
        redactedDesc.includes('[REDACTED]') ||
        redactedContent.includes('[REDACTED]');
      if (looksLikeSensitiveMemory(rawJoined) || redactedMutated) {
        rejectedSensitive++;
        continue;
      }
      candidates.push(candidate);
    }
    return {
      candidates,
      rejectedSensitive,
      skippedExisting,
      ...(reportedUsage ? {usage: reportedUsage} : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}
