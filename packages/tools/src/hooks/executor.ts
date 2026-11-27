import {
  FutrynError,
  type CommandRuntime,
  type ConfiguredHook,
  type HookInput,
  type HookOutcome,
  type HookPort,
  type HookRanEvent,
  type HooksSnapshot,
  type PermissionMode,
  type PermissionSettingsSnapshot,
} from '@cosmew/contracts';
import {matchesHookMatcher} from '@cosmew/security';
import {DEFAULT_SANDBOX_CONFIG, type SandboxConfig} from '../context';
import {clipBytes} from '../limits';

const MAX_HOOK_OUTPUT_BYTES = 32 * 1024;
const MAX_HOOK_CONTEXT_BYTES = 8 * 1024;
const MAX_HOOK_REASON_BYTES = 4 * 1024;
const MAX_HOOK_TOOL_RESULT_BYTES = 16 * 1024;
const MAX_HOOK_SUMMARY_CHARS = 200;

const SAFE_ENV_EXACT = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SHELL',
  'PWD',
  'TZ',
  'CI',
  'NODE_ENV',
  'BUN_INSTALL',
  'GOPATH',
  'GOROOT',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'VIRTUAL_ENV',
  'PYENV_ROOT',
  'NVM_DIR',
  'VOLTA_HOME',
  'PNPM_HOME',
  'COLORTERM',
  'NO_COLOR',
]);

const SENSITIVE_ENV_PATTERN =
  /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|PRIVATE|CERT|OPENAI|ANTHROPIC|GEMINI|CLAUDE|AWS_|AZURE_|GCP_|GOOGLE_API|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|DOCKER_AUTH)/i;

export interface HookExecutorOptions {
  workspace: string;
  getSettings(): PermissionSettingsSnapshot;
  getPermissionMode(): PermissionMode;
  redact(text: string): string;
  /** Optional OS sandbox runtime (or lazy getter) used when `sandbox.enabled` is true (never silently bypassed). */
  commands?: CommandRuntime | (() => CommandRuntime | undefined);
  getSandboxConfig?(): SandboxConfig;
  /** Test seam for host POSIX shell path; defaults to `/bin/sh`. */
  shell?: string;
}

interface RawHookRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  errorSummary?: string;
}

function shellSingleQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function sanitizeHookEnv(
  workspace: string,
  input: HookInput,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (typeof value !== 'string') continue;
    if (SENSITIVE_ENV_PATTERN.test(key)) continue;
    if (SAFE_ENV_EXACT.has(key) || key.startsWith('LC_') || key.startsWith('XDG_')) {
      env[key] = value;
    }
  }
  env.COSMEW_HOOK_EVENT = input.event;
  env.COSMEW_PROJECT_DIR = workspace;
  env.CLAUDE_PROJECT_DIR = workspace;
  if (input.sessionId) env.COSMEW_SESSION_ID = input.sessionId;
  return env;
}

function redactPayloadValue(value: unknown, redact: (text: string) => string, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactPayloadValue(item, redact, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      out[redact(key)] = redactPayloadValue(entry, redact, depth + 1);
    }
    return out;
  }
  return value;
}

function buildHookPayloadJson(workspace: string, input: HookInput, redact: (text: string) => string): string {
  const payload: Record<string, unknown> = {
    hook_event_name: input.event,
    cwd: redact(input.cwd ?? workspace),
    ...(input.sessionId ? {session_id: input.sessionId} : {}),
    ...(input.toolName ? {tool_name: input.toolName} : {}),
    ...(input.toolInput ? {tool_input: redactPayloadValue(input.toolInput, redact)} : {}),
    ...(input.toolResult
      ? {
          tool_response: {
            status: input.toolResult.status,
            ...(input.toolResult.code ? {code: input.toolResult.code} : {}),
            content: clipBytes(redact(input.toolResult.content), MAX_HOOK_TOOL_RESULT_BYTES).text,
          },
        }
      : {}),
    ...(input.prompt !== undefined ? {prompt: clipBytes(redact(input.prompt), MAX_HOOK_TOOL_RESULT_BYTES).text} : {}),
    ...(input.stopHookActive !== undefined ? {stop_hook_active: input.stopHookActive} : {}),
  };
  return JSON.stringify(payload).replaceAll('\u0000', '');
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      if (total < maxBytes) {
        const remaining = maxBytes - total;
        const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
        chunks.push(slice);
        total += slice.byteLength;
      }
    }
  } catch {
    /* stream closed on kill/cancel */
  } finally {
    void reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

function hookDisplayName(hook: ConfiguredHook): string {
  const cmd = hook.command.replace(/\s+/g, ' ').trim();
  const head = cmd.length > 48 ? cmd.slice(0, 45) + '...' : cmd;
  return `${hook.scope}:${hook.matcher ? `${hook.matcher}:` : ''}${head}`;
}

function summarize(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_HOOK_SUMMARY_CHARS ? oneLine.slice(0, MAX_HOOK_SUMMARY_CHARS - 3) + '...' : oneLine;
}

function parseHookJsonOutput(rawStdout: string): {
  blocked: boolean;
  reason?: string;
  additionalContext?: string;
} | null {
  const trimmed = rawStdout.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const specific =
    obj.hookSpecificOutput && typeof obj.hookSpecificOutput === 'object' && !Array.isArray(obj.hookSpecificOutput)
      ? (obj.hookSpecificOutput as Record<string, unknown>)
      : undefined;
  // Security invariant: hooks may only block or add context; "allow" decisions are intentionally ignored.
  const blocked = obj.decision === 'block' || obj.continue === false || specific?.permissionDecision === 'deny';
  const reason = [specific?.permissionDecisionReason, obj.reason, obj.stopReason].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  const contextParts = [specific?.additionalContext, obj.additionalContext, obj.systemMessage].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  return {
    blocked,
    ...(reason ? {reason: reason.trim()} : {}),
    ...(contextParts.length ? {additionalContext: contextParts.join('\n')} : {}),
  };
}

/**
 * Executes trusted lifecycle command hooks (ADR 0120).
 * - Never runs hooks from untrusted repository settings (filtered upstream by `mergeSettings`).
 * - Disabled in `plan` mode (read-only invariant).
 * - Respects `sandbox.enabled` without ever silently falling back outside the sandbox.
 * - Never grants permissions or bypasses dispatcher policy/approval checks.
 */
export class HookExecutor implements HookPort {
  constructor(private readonly options: HookExecutorOptions) {}

  snapshot(): HooksSnapshot {
    const settings = this.options.getSettings();
    const mode = this.options.getPermissionMode();
    const enabled = mode !== 'plan';
    const hooks = (settings.hooks ?? []).map(hook => ({
      scope: hook.scope,
      event: hook.event,
      ...(hook.matcher ? {matcher: hook.matcher} : {}),
      command: this.options.redact(hook.command),
      timeoutMs: hook.timeoutMs,
    }));
    return {
      supported: true,
      enabled,
      ...(!enabled ? {disabledReason: 'Hooks are disabled in plan mode (read-only).'} : {}),
      hooks,
      untrustedPendingCount: settings.untrustedHooksCount ?? 0,
    };
  }

  async run(input: HookInput, signal?: AbortSignal): Promise<HookOutcome> {
    if (signal?.aborted) throw new FutrynError('CANCELLED');
    if (this.options.getPermissionMode() === 'plan') {
      return {action: 'continue', events: []};
    }
    const settings = this.options.getSettings();
    const matched = (settings.hooks ?? []).filter(hook => {
      if (hook.event !== input.event) return false;
      if (input.event === 'PreToolUse' || input.event === 'PostToolUse') {
        return matchesHookMatcher(hook.matcher, input.toolName);
      }
      return !hook.matcher || hook.matcher === '*';
    });
    if (!matched.length) return {action: 'continue', events: []};

    const payloadJson = buildHookPayloadJson(this.options.workspace, input, this.options.redact);
    const events: HookRanEvent[] = [];
    const contexts: string[] = [];

    for (const hook of matched) {
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      const name = this.options.redact(hookDisplayName(hook));
      const raw = settings.sandbox.enabled
        ? await this.runSandboxed(hook, payloadJson, signal)
        : await this.runDirect(hook, input, payloadJson, signal);
      if (signal?.aborted) throw new FutrynError('CANCELLED');

      if (raw.errorSummary) {
        events.push({
          type: 'hook.ran',
          event: input.event,
          name,
          summary: summarize(this.options.redact(raw.errorSummary)),
        });
        continue;
      }

      if (raw.timedOut) {
        const seconds = Math.max(1, Math.round(hook.timeoutMs / 1000));
        events.push({
          type: 'hook.ran',
          event: input.event,
          name,
          summary: `Timed out after ${seconds}s`,
        });
        continue;
      }

      const safeStdout = this.options.redact(raw.stdout);
      const safeStderr = this.options.redact(raw.stderr);

      if (raw.exitCode === 2) {
        const parsed = parseHookJsonOutput(safeStdout);
        const reason = clipBytes(
          parsed?.reason || safeStderr.trim() || safeStdout.trim() || `Blocked by ${input.event} hook.`,
          MAX_HOOK_REASON_BYTES,
        ).text;
        events.push({
          type: 'hook.ran',
          event: input.event,
          name,
          summary: summarize(`Blocked: ${reason}`),
          blocked: true,
        });
        return {
          action: 'block',
          reason,
          ...(contexts.length
            ? {additionalContext: clipBytes(contexts.join('\n\n'), MAX_HOOK_CONTEXT_BYTES).text}
            : {}),
          events,
        };
      }

      if (raw.exitCode === 0) {
        const parsed = parseHookJsonOutput(safeStdout);
        if (parsed?.blocked) {
          const reason = clipBytes(parsed.reason || `Blocked by ${input.event} hook.`, MAX_HOOK_REASON_BYTES).text;
          events.push({
            type: 'hook.ran',
            event: input.event,
            name,
            summary: summarize(`Blocked: ${reason}`),
            blocked: true,
          });
          return {
            action: 'block',
            reason,
            ...(contexts.length
              ? {additionalContext: clipBytes(contexts.join('\n\n'), MAX_HOOK_CONTEXT_BYTES).text}
              : {}),
            events,
          };
        }
        const added =
          parsed?.additionalContext ??
          (parsed === null &&
          safeStdout.trim() &&
          (input.event === 'UserPromptSubmit' || input.event === 'SessionStart' || input.event === 'PostToolUse')
            ? safeStdout.trim()
            : undefined);
        if (added) contexts.push(added);
        events.push({
          type: 'hook.ran',
          event: input.event,
          name,
          summary: added ? summarize(added) : 'ok',
        });
        continue;
      }

      const detail = safeStderr.trim() || safeStdout.trim();
      events.push({
        type: 'hook.ran',
        event: input.event,
        name,
        summary: summarize(`Exited with code ${raw.exitCode ?? 'unknown'}${detail ? `: ${detail}` : ''}`),
      });
    }

    const combined = contexts.length ? clipBytes(contexts.join('\n\n'), MAX_HOOK_CONTEXT_BYTES).text : undefined;
    return {
      action: 'continue',
      ...(combined ? {additionalContext: combined} : {}),
      events,
    };
  }

  private async runSandboxed(hook: ConfiguredHook, payloadJson: string, signal?: AbortSignal): Promise<RawHookRun> {
    const runtime = typeof this.options.commands === 'function' ? this.options.commands() : this.options.commands;
    if (!runtime) {
      return {
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        errorSummary: 'Skipped: sandbox is enabled but no sandbox runtime is available.',
      };
    }
    const availability = runtime.availability();
    if (!availability.ok) {
      return {
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        errorSummary: `Skipped: sandbox unavailable (${availability.reason}).`,
      };
    }
    const modes = runtime.capabilities?.().modes ?? ['read-only'];
    const sandboxCfg = this.options.getSandboxConfig?.() ?? DEFAULT_SANDBOX_CONFIG;
    const desired = sandboxCfg.readOnly ? 'read-only' : 'workspace-write';
    const mode = modes.includes(desired) ? desired : modes.includes('read-only') ? 'read-only' : undefined;
    if (!mode) {
      return {
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        errorSummary: 'Skipped: sandbox runtime cannot enforce a confined mode for hooks.',
      };
    }
    let stdout = '';
    let stderr = '';
    const wrappedCommand = `printf '%s' ${shellSingleQuote(payloadJson)} | sh -c ${shellSingleQuote(hook.command)}`;
    try {
      const outcome = await runtime.run(
        {
          command: wrappedCommand,
          cwd: this.options.workspace,
          timeoutMs: hook.timeoutMs,
          maxOutputBytes: MAX_HOOK_OUTPUT_BYTES,
          shell: 'sh',
          sandbox: {
            mode,
            network: false,
            writableRoots: sandboxCfg.additionalDirectories,
            denyRead: sandboxCfg.denyRead,
            denyWrite: sandboxCfg.denyWrite,
          },
          onOutput: chunk => {
            if (chunk.stream === 'stdout') {
              if (Buffer.byteLength(stdout) < MAX_HOOK_OUTPUT_BYTES) stdout += chunk.text;
            } else if (Buffer.byteLength(stderr) < MAX_HOOK_OUTPUT_BYTES) {
              stderr += chunk.text;
            }
          },
        },
        signal,
      );
      if (outcome.kind === 'cancelled') throw new FutrynError('CANCELLED');
      if (outcome.sandboxFailed) {
        return {
          exitCode: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          errorSummary: 'Skipped: sandbox failed to launch hook.',
        };
      }
      if (!stdout && !stderr && outcome.output) stdout = outcome.output;
      return {
        exitCode: outcome.exitCode,
        stdout: clipBytes(stdout, MAX_HOOK_OUTPUT_BYTES).text,
        stderr: clipBytes(stderr, MAX_HOOK_OUTPUT_BYTES).text,
        timedOut: outcome.kind === 'timeout',
      };
    } catch (error) {
      if (signal?.aborted || (error instanceof FutrynError && error.code === 'CANCELLED')) {
        throw new FutrynError('CANCELLED');
      }
      return {
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        errorSummary: 'Hook execution failed inside sandbox.',
      };
    }
  }

  private async runDirect(
    hook: ConfiguredHook,
    input: HookInput,
    payloadJson: string,
    signal?: AbortSignal,
  ): Promise<RawHookRun> {
    const shell = this.options.shell ?? (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
    const argv =
      process.platform === 'win32' && !this.options.shell ? [shell, '/c', hook.command] : [shell, '-c', hook.command];
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(argv, {
        cwd: this.options.workspace,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: sanitizeHookEnv(this.options.workspace, input),
      });
    } catch {
      return {
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        errorSummary: 'Failed to start hook shell process.',
      };
    }

    let timedOut = false;
    const terminate = () => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, hook.timeoutMs);
    const onAbort = () => terminate();
    signal?.addEventListener('abort', onAbort, {once: true});

    try {
      if (proc.stdin && typeof proc.stdin !== 'number') {
        try {
          proc.stdin.write(payloadJson);
          await proc.stdin.end();
        } catch {
          /* hook closed stdin early */
        }
      }
      const stdoutPromise = readBoundedStream(
        typeof proc.stdout === 'number' ? null : proc.stdout,
        MAX_HOOK_OUTPUT_BYTES,
      );
      const stderrPromise = readBoundedStream(
        typeof proc.stderr === 'number' ? null : proc.stderr,
        MAX_HOOK_OUTPUT_BYTES,
      );
      const exitCode = await proc.exited;
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      return {exitCode, stdout, stderr, timedOut};
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
