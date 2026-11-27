import type {Usage} from './models';

export const AUTOMATION_LIMITS = {
  minIntervalMs: 5_000,
  maxIntervalMs: 86_400_000,
  defaultLoopMaxIterations: 10,
  defaultScheduleMaxIterations: 20,
  maxIterationsCap: 100,
  maxJobsPerSession: 8,
  maxConsecutiveErrors: 3,
  maxBatchItems: 12,
  maxPromptChars: 16_384,
} as const;

export type ScheduledJobKind = 'loop' | 'schedule';
export type ScheduledJobStatus = 'active' | 'running' | 'completed' | 'stopped' | 'failed' | 'budget_exceeded';

export interface ScheduledJobSpec {
  kind: ScheduledJobKind;
  prompt: string;
  intervalMs: number;
  runImmediately: boolean;
  maxIterations: number;
  maxEstimatedCostUSD?: number;
  untilSubstring?: string;
  oneShot?: boolean;
}

export interface ScheduledJobView {
  id: string;
  sessionId: string;
  kind: ScheduledJobKind;
  prompt: string;
  intervalMs: number;
  maxIterations: number;
  completedIterations: number;
  consecutiveErrors: number;
  maxEstimatedCostUSD?: number;
  untilSubstring?: string;
  oneShot?: boolean;
  status: ScheduledJobStatus;
  createdAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  stopReason?: string;
}

export interface ScheduledJobEvent {
  type: 'scheduled.started' | 'scheduled.tick' | 'scheduled.completed' | 'scheduled.stopped' | 'scheduled.failed';
  job: ScheduledJobView;
  message?: string;
}

export interface BatchTaskInput {
  label: string;
  prompt: string;
  agentType?: string;
  isolation?: 'worktree';
}

export interface BatchRunRequest {
  items: BatchTaskInput[];
  agentType?: string;
  isolation?: 'worktree';
  concurrency?: number;
}

export type BatchTaskItemStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface BatchTaskItemView {
  index: number;
  label: string;
  agentType: string;
  isolation?: 'worktree';
  status: BatchTaskItemStatus;
  agentId?: string;
  durationMs?: number;
  toolCount?: number;
  usage?: Usage | null;
  summary?: string;
  errorCode?: string;
}

export interface BatchRunResult {
  status: 'completed' | 'partial' | 'failed' | 'cancelled';
  items: BatchTaskItemView[];
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  usage: Usage | null;
  durationMs: number;
  summary: string;
}

export type ParsedAutomationCommand =
  | {action: 'list'}
  | {action: 'stop'; target: string}
  | {action: 'start'; spec: ScheduledJobSpec}
  | {action: 'error'; message: string};

export interface AutomationParseOptions {
  minIntervalMs?: number;
  maxIntervalMs?: number;
}

export type ParsedBatchCommand = {ok: true; request: BatchRunRequest} | {ok: false; message: string};

const DEFAULT_LOOP_INTERVAL_MS = 5 * 60_000;

/** Parse compact durations like `30s`, `5m`, `1h`, `1h30m`, `2m30s` into milliseconds. */
export function parseDurationMs(raw: string, options?: AutomationParseOptions): number | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;
  const tokenRe = /(\d+)(ms|s|m|h)/g;
  let total = 0;
  let matchedLen = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(trimmed)) !== null) {
    if (match.index !== matchedLen) return undefined;
    matchedLen += match[0].length;
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || value <= 0) return undefined;
    const unit = match[2];
    const mult = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000;
    total += value * mult;
    if (total > Number.MAX_SAFE_INTEGER) return undefined;
  }
  if (matchedLen !== trimmed.length || total <= 0) return undefined;
  const minMs = options?.minIntervalMs ?? AUTOMATION_LIMITS.minIntervalMs;
  const maxMs = options?.maxIntervalMs ?? AUTOMATION_LIMITS.maxIntervalMs;
  if (total < minMs || total > maxMs) return undefined;
  return total;
}

export function formatDurationMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1_000);
  const hours = Math.floor(totalSec / 3_600);
  const mins = Math.floor((totalSec % 3_600) / 60);
  const secs = totalSec % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  return parts.join('');
}

function tokenizeLeadingArgs(raw: string): {tokens: string[]; restStart: number}[] {
  const out: {tokens: string[]; restStart: number}[] = [];
  let index = 0;
  const len = raw.length;
  while (index < len) {
    while (index < len && /\s/.test(raw[index]!)) index++;
    if (index >= len) break;
    const start = index;
    const ch = raw[index]!;
    if (ch === '"' || ch === "'") {
      const quote = ch;
      index++;
      let value = '';
      while (index < len && raw[index] !== quote) {
        if (raw[index] === '\\' && index + 1 < len) {
          value += raw[index + 1]!;
          index += 2;
        } else {
          value += raw[index]!;
          index++;
        }
      }
      if (index < len && raw[index] === quote) index++;
      out.push({tokens: [value], restStart: start});
    } else {
      while (index < len && !/\s/.test(raw[index]!)) index++;
      out.push({tokens: [raw.slice(start, index)], restStart: start});
    }
  }
  return out;
}

function parseSharedAutomationFlags(
  raw: string,
  kind: ScheduledJobKind,
  defaults: {intervalMs: number; runImmediately: boolean; maxIterations: number; oneShot?: boolean},
  options?: AutomationParseOptions,
): ParsedAutomationCommand {
  const parts = tokenizeLeadingArgs(raw);
  if (parts.length === 0) return {action: 'list'};

  const first = parts[0]!.tokens[0]!.toLowerCase();
  if (first === 'list' || first === 'status') return {action: 'list'};
  if (first === 'stop' || first === 'cancel') {
    const target = parts[1]?.tokens[0]?.trim() || 'all';
    return {action: 'stop', target};
  }

  let intervalMs = defaults.intervalMs;
  let runImmediately = defaults.runImmediately;
  let maxIterations = defaults.maxIterations;
  let oneShot = defaults.oneShot ?? false;
  let maxEstimatedCostUSD: number | undefined;
  let untilSubstring: string | undefined;

  let cursor = 0;
  if (kind === 'schedule') {
    if (first === 'every' || first === 'in') {
      const durRaw = parts[1]?.tokens[0];
      const parsedDur = durRaw ? parseDurationMs(durRaw, options) : undefined;
      if (!parsedDur) {
        return {
          action: 'error',
          message: `Invalid ${first} duration. Use e.g. 30s, 5m, 1h (between ${formatDurationMs(options?.minIntervalMs ?? AUTOMATION_LIMITS.minIntervalMs)} and ${formatDurationMs(options?.maxIntervalMs ?? AUTOMATION_LIMITS.maxIntervalMs)}).`,
        };
      }
      intervalMs = parsedDur;
      if (first === 'in') {
        oneShot = true;
        maxIterations = 1;
        runImmediately = false;
      } else {
        runImmediately = false;
      }
      cursor = 2;
    } else {
      const maybeDur = parseDurationMs(parts[0]!.tokens[0]!, options);
      if (maybeDur) {
        intervalMs = maybeDur;
        cursor = 1;
      }
    }
  } else {
    const maybeDur = parseDurationMs(parts[0]!.tokens[0]!, options);
    if (maybeDur) {
      intervalMs = maybeDur;
      cursor = 1;
    }
  }

  while (cursor < parts.length) {
    const token = parts[cursor]!.tokens[0]!;
    if (token === '--every' || token === '--interval') {
      const val = parts[cursor + 1]?.tokens[0];
      const parsedDur = val ? parseDurationMs(val, options) : undefined;
      if (!parsedDur) {
        return {action: 'error', message: `Invalid value for ${token}. Expected duration like 30s, 5m, 1h.`};
      }
      intervalMs = parsedDur;
      cursor += 2;
    } else if (token === '--max' || token === '--max-iterations') {
      const val = Number(parts[cursor + 1]?.tokens[0]);
      if (!Number.isInteger(val) || val < 1 || val > AUTOMATION_LIMITS.maxIterationsCap) {
        return {
          action: 'error',
          message: `Invalid value for ${token}. Must be an integer between 1 and ${AUTOMATION_LIMITS.maxIterationsCap}.`,
        };
      }
      maxIterations = val;
      cursor += 2;
    } else if (token === '--max-cost' || token === '--max-budget-usd') {
      const val = Number(parts[cursor + 1]?.tokens[0]);
      if (!Number.isFinite(val) || val <= 0 || val > 1000) {
        return {action: 'error', message: `Invalid value for ${token}. Must be a positive USD number.`};
      }
      maxEstimatedCostUSD = val;
      cursor += 2;
    } else if (token === '--until') {
      const val = parts[cursor + 1]?.tokens[0]?.trim();
      if (!val) {
        return {action: 'error', message: 'Missing stop condition string after --until.'};
      }
      untilSubstring = val.slice(0, 200);
      cursor += 2;
    } else if (token === '--now') {
      runImmediately = true;
      cursor += 1;
    } else if (token === '--') {
      cursor += 1;
      break;
    } else {
      break;
    }
  }

  const promptStart = parts[cursor]?.restStart;
  const prompt = promptStart === undefined ? '' : raw.slice(promptStart).trim();
  if (!prompt) {
    return {
      action: 'error',
      message:
        kind === 'loop'
          ? 'Usage: /loop [interval] [--max N] [--max-cost USD] [--until "text"] <prompt> · /loop list · /loop stop [id|all]'
          : 'Usage: /schedule every <interval> [--max N] <prompt> · /schedule in <delay> <prompt> · /schedule list · /schedule stop [id|all]',
    };
  }
  if (prompt.length > AUTOMATION_LIMITS.maxPromptChars) {
    return {
      action: 'error',
      message: `Prompt exceeds maximum length (${AUTOMATION_LIMITS.maxPromptChars} characters).`,
    };
  }

  return {
    action: 'start',
    spec: {
      kind,
      prompt,
      intervalMs,
      runImmediately,
      maxIterations: oneShot ? 1 : maxIterations,
      ...(maxEstimatedCostUSD !== undefined ? {maxEstimatedCostUSD} : {}),
      ...(untilSubstring !== undefined ? {untilSubstring} : {}),
      ...(oneShot ? {oneShot: true} : {}),
    },
  };
}

export function parseLoopCommand(rawArgs: string, options?: AutomationParseOptions): ParsedAutomationCommand {
  return parseSharedAutomationFlags(
    rawArgs,
    'loop',
    {
      intervalMs: DEFAULT_LOOP_INTERVAL_MS,
      runImmediately: true,
      maxIterations: AUTOMATION_LIMITS.defaultLoopMaxIterations,
    },
    options,
  );
}

export function parseScheduleCommand(rawArgs: string, options?: AutomationParseOptions): ParsedAutomationCommand {
  return parseSharedAutomationFlags(
    rawArgs,
    'schedule',
    {
      intervalMs: DEFAULT_LOOP_INTERVAL_MS,
      runImmediately: false,
      maxIterations: AUTOMATION_LIMITS.defaultScheduleMaxIterations,
    },
    options,
  );
}

function readBatchFlagValue(raw: string, startIndex: number): {value: string; nextIndex: number} | undefined {
  let index = startIndex;
  while (index < raw.length && /\s/.test(raw[index]!)) index++;
  if (index >= raw.length) return undefined;
  const ch = raw[index]!;
  if (ch === '"' || ch === "'") {
    const quote = ch;
    index++;
    let value = '';
    while (index < raw.length && raw[index] !== quote) {
      if (raw[index] === '\\' && index + 1 < raw.length) {
        value += raw[index + 1]!;
        index += 2;
      } else {
        value += raw[index]!;
        index++;
      }
    }
    if (index < raw.length && raw[index] === quote) index++;
    return {value, nextIndex: index};
  }
  const endStart = index;
  while (index < raw.length && !/\s/.test(raw[index]!)) index++;
  return {value: raw.slice(endStart, index), nextIndex: index};
}

export function parseBatchCommand(rawArgs: string): ParsedBatchCommand {
  const input = rawArgs.trim();
  if (!input) {
    return {
      ok: false,
      message:
        'Usage: /batch [--isolation worktree|none] [--agent <type>] [--concurrency N] <task 1> ;; <task 2> | /batch --targets "a,b" <prompt with {{target}}>',
    };
  }

  let index = 0;
  let agentType: string | undefined;
  let isolation: 'worktree' | undefined;
  let concurrency: number | undefined;
  let targetsRaw: string | undefined;

  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index]!)) index++;
    if (!input.startsWith('--', index)) break;
    const tokenStart = index;
    while (index < input.length && !/\s/.test(input[index]!)) index++;
    const flag = input.slice(tokenStart, index);
    if (flag === '--') break;

    if (flag === '--isolation') {
      const val = readBatchFlagValue(input, index);
      if (!val || (val.value !== 'worktree' && val.value !== 'none')) {
        return {ok: false, message: 'Invalid --isolation value. Supported: worktree, none.'};
      }
      isolation = val.value === 'worktree' ? 'worktree' : undefined;
      index = val.nextIndex;
    } else if (flag === '--agent') {
      const val = readBatchFlagValue(input, index);
      if (!val || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(val.value)) {
        return {ok: false, message: 'Invalid --agent value.'};
      }
      agentType = val.value;
      index = val.nextIndex;
    } else if (flag === '--concurrency') {
      const val = readBatchFlagValue(input, index);
      const parsed = val ? Number(val.value) : NaN;
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > AUTOMATION_LIMITS.maxBatchItems) {
        return {
          ok: false,
          message: `Invalid --concurrency value. Must be an integer between 1 and ${AUTOMATION_LIMITS.maxBatchItems}.`,
        };
      }
      concurrency = parsed;
      index = val!.nextIndex;
    } else if (flag === '--targets') {
      const val = readBatchFlagValue(input, index);
      if (!val || !val.value.trim()) {
        return {ok: false, message: 'Missing comma-separated list after --targets.'};
      }
      targetsRaw = val.value;
      index = val.nextIndex;
    } else {
      return {ok: false, message: `Unknown /batch option "${flag}".`};
    }
  }

  const body = input.slice(index).trim();
  if (!body) {
    return {ok: false, message: 'Missing task prompt(s) for /batch.'};
  }

  const items: BatchTaskInput[] = [];
  if (targetsRaw !== undefined) {
    const targets = targetsRaw
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);
    if (targets.length === 0) {
      return {ok: false, message: 'No valid targets found in --targets.'};
    }
    if (targets.length > AUTOMATION_LIMITS.maxBatchItems) {
      return {
        ok: false,
        message: `/batch supports at most ${AUTOMATION_LIMITS.maxBatchItems} tasks per run (got ${targets.length}).`,
      };
    }
    for (const target of targets) {
      const prompt = body.includes('{{target}}')
        ? body.replaceAll('{{target}}', target)
        : `${body}\n\nTarget: ${target}`;
      if (prompt.length > AUTOMATION_LIMITS.maxPromptChars) {
        return {ok: false, message: `Task prompt for "${target}" exceeds maximum length.`};
      }
      items.push({
        label: target.slice(0, 120),
        prompt,
        ...(agentType ? {agentType} : {}),
        ...(isolation ? {isolation} : {}),
      });
    }
  } else {
    const segments = body
      .split(';;')
      .map(s => s.trim())
      .filter(Boolean);
    if (segments.length === 0) {
      return {ok: false, message: 'No tasks provided to /batch.'};
    }
    if (segments.length > AUTOMATION_LIMITS.maxBatchItems) {
      return {
        ok: false,
        message: `/batch supports at most ${AUTOMATION_LIMITS.maxBatchItems} tasks per run (got ${segments.length}).`,
      };
    }
    for (let i = 0; i < segments.length; i++) {
      const prompt = segments[i]!;
      if (prompt.length > AUTOMATION_LIMITS.maxPromptChars) {
        return {ok: false, message: `Task #${i + 1} exceeds maximum prompt length.`};
      }
      items.push({
        label: prompt.replace(/\s+/g, ' ').slice(0, 80),
        prompt,
        ...(agentType ? {agentType} : {}),
        ...(isolation ? {isolation} : {}),
      });
    }
  }

  return {
    ok: true,
    request: {
      items,
      ...(agentType ? {agentType} : {}),
      ...(isolation ? {isolation} : {}),
      ...(concurrency !== undefined ? {concurrency} : {}),
    },
  };
}
