import type {CommandRequest, CommandRuntime, CommandSandbox} from '@cosmew/contracts';
import {MAX_COMMAND_CHARS} from '@cosmew/security';
import {effectiveSandboxMode, sandboxConfig, type ToolDispatcherOptions, type ToolOutput} from '../context';
import {outsideWorkingDirectories, resolveWorkspacePath} from '../working-roots';
import {EXEC_LIMITS, clampYield, execDescriptor, execInput, shellOf, type ExecInput} from '../exec/command';
import {runCommand} from '../runtimes/process';
import type {PreparedTool, ToolHandler} from './types';

const refuse = (code: string, content: string): ToolOutput => ({status: 'error', code, content});

/** Capabilities assumed for runtimes that predate ADR 0034: pipes only, bash, no network. */
const LEGACY_CAPABILITIES = {network: false, tty: false, unsandboxed: false, shells: ['bash'] as ('bash' | 'sh')[]};

/**
 * `exec_command` preparation (Codex handlers/unified_exec/preparation.rs, pinned 75fc67e8, under the
 * ADR 0061 settings): validate the arguments, decide the effective sandbox, and build the request.
 * Nothing runs here; the orchestrator authorizes and revalidates before `execute`.
 */
export function commandHandler(options: ToolDispatcherOptions): ToolHandler {
  return {
    descriptor: execDescriptor,
    // Offered while the backend is healthy, when the sandbox is turned off, or when the user allows
    // unsandboxed commands (every such run still needs its own approval; sandbox-required commands
    // fail closed). Only `allowUnsandboxedCommands: false` with a broken backend removes the tool.
    available: () => {
      if (!options.commands) return false;
      const config = sandboxConfig(options);
      if (options.commands.availability().ok) return true;
      // Only a runtime that can really run an approved command without its sandbox is offered while unhealthy;
      // `COSMEW_COMMAND_BACKEND=none` / unsupported platforms stay closed.
      return options.commands.capabilities?.().unsandboxed === true && (!config.enabled || config.allowUnsandboxed);
    },
    unavailable: {
      status: 'error',
      code: 'SANDBOX_UNAVAILABLE',
      content: 'exec_command is unavailable: no verified command sandbox on this host. Nothing was run.',
    },

    prepare(args) {
      const parsed = execInput.safeParse(args);
      if (!parsed.success) {
        const cmdTooLong = parsed.error.issues.some(issue => issue.path[0] === 'cmd' && issue.code === 'too_big');
        if (cmdTooLong) {
          return refuse(
            'INVALID_INPUT',
            `Invalid arguments for exec_command: cmd exceeds the ${MAX_COMMAND_CHARS}-character limit. Shorten the command, split it into steps, or run a script file instead.`,
          );
        }
        const unknownKeys = parsed.error.issues.flatMap(issue =>
          issue.code === 'unrecognized_keys' ? issue.keys.slice(0, 5) : [],
        );
        const detail = unknownKeys.length ? ` Unsupported parameter(s): ${unknownKeys.join(', ')}.` : '';
        return refuse(
          'INVALID_INPUT',
          `Invalid arguments for exec_command.${detail} Supported: cmd (required, max ${MAX_COMMAND_CHARS} chars), workdir, tty, shell, login, yield_time_ms, max_output_tokens, timeout_ms, dangerouslyDisableSandbox, justification.`,
        );
      }
      const input = parsed.data;
      const runtime = options.commands!;
      const config = sandboxConfig(options);

      // With the sandbox disabled in settings every command already runs without it, so the escape
      // hatch has nothing to escape from and is an ordinary command.
      const escalated = input.dangerouslyDisableSandbox === true && config.enabled;
      if (escalated && !input.justification)
        return refuse(
          'INVALID_INPUT',
          'dangerouslyDisableSandbox needs a justification for the user. Nothing was run.',
        );

      const mode = effectiveSandboxMode(options, runtime);
      if (!mode)
        return refuse('SANDBOX_UNAVAILABLE', 'This runtime cannot enforce the configured sandbox. Nothing was run.');
      // The escape hatch runs unsandboxed exactly once; the orchestrator asks the user before it can run.
      const unsandboxed = escalated || mode === 'danger-full-access';
      const sandbox: CommandSandbox = {
        mode: escalated ? 'danger-full-access' : mode,
        network: unsandboxed,
        ...(unsandboxed ? {unsandboxed: true} : {}),
        ...(!unsandboxed && mode === 'workspace-write' && config.additionalDirectories.length
          ? {writableRoots: [...config.additionalDirectories]}
          : {}),
        ...(!unsandboxed && config.denyRead?.length ? {denyRead: [...config.denyRead]} : {}),
        ...(!unsandboxed && config.denyWrite?.length ? {denyWrite: [...config.denyWrite]} : {}),
      };

      const shell = shellOf(input.shell);
      const capabilityError = checkCapabilities(runtime, input, shell, sandbox);
      if (capabilityError) return capabilityError;

      const file = resolveWorkspacePath(options, input.workdir ?? '.');
      if (file.kind !== 'directory')
        return {
          status: 'error',
          code: 'NOT_A_DIRECTORY',
          content: `${file.relative} is not a directory.`,
          target: file.relative,
        };

      const outsideCwd = outsideWorkingDirectories(options, file.absolute);
      const sessions = !!runtime.writeStdin;
      const label = options.redact(`${file.relative === '.' ? '' : file.relative + ': '}${input.cmd}`).slice(0, 1024);
      const request = buildRequest(input, file.absolute, sandbox, shell!, sessions);
      request.taskSessionId = options.sessionId?.();
      // Seatbelt writable roots stay off an unsandboxed or read-only command. The cwd
      // roots include the exact external cwd for this invocation and are checked by the runtime.
      request.cwdRoots = [...config.additionalDirectories, ...(outsideCwd ? [file.absolute] : [])];
      // A sandbox denial may be retried unsandboxed only when the settings allow it and the user can still be asked.
      const canEscalate = config.enabled && !escalated && config.allowUnsandboxed;
      // The approval scope binds everything that changes authority or lifetime, not just the text.
      const executionKey = JSON.stringify({
        timeoutMs: request.timeoutMs,
        session: sessions,
        sandbox,
        tty: request.tty,
        shell,
        login: request.login,
      });

      const prepared: Extract<PreparedTool, {kind: 'command'}> = {
        kind: 'command',
        file,
        command: input.cmd,
        workdir: input.workdir ?? '.',
        outsideCwd,
        label,
        runtime,
        runtimeId: runtime.id,
        executionKey,
        shell: shell!,
        sandbox,
        ...(escalated ? {escalation: true} : {}),
        ...(input.justification ? {justification: input.justification} : {}),
        execute: async (signal, onOutput) => {
          // The domain-filtering proxy is the only network a sandboxed command has (ADR 0061). The
          // orchestrator may have switched this command to unsandboxed (excluded command) by now.
          if (!sandbox.unsandboxed && config.network && options.proxy) {
            try {
              sandbox.proxyUrl = await options.proxy.ensure();
              if (process.platform === 'linux' && options.proxy.ensureUnix) {
                sandbox.proxySocketPath = await options.proxy.ensureUnix();
              }
            } catch {
              return refuse('SANDBOX_FAILED', 'The sandbox network proxy could not start. Nothing was run.');
            }
          }
          return runCommand(runtime, {...request, onOutput}, label, signal, canEscalate);
        },
      };
      return prepared;
    },
  };
}

/** A request the runtime cannot enforce is refused, never silently downgraded. */
function checkCapabilities(
  runtime: CommandRuntime,
  input: ExecInput,
  shell: 'bash' | 'sh' | undefined,
  sandbox: CommandSandbox,
): ToolOutput | undefined {
  const capabilities = runtime.capabilities?.() ?? LEGACY_CAPABILITIES;
  if (!shell || !capabilities.shells.includes(shell)) {
    return refuse(
      'UNSUPPORTED',
      `Shell ${JSON.stringify(input.shell)} is not available in this sandbox (available: ${capabilities.shells.join(', ')}). Nothing was run.`,
    );
  }
  if (input.tty && !capabilities.tty)
    return refuse('UNSUPPORTED', 'This runtime cannot allocate a PTY; omit tty. Nothing was run.');
  if (sandbox.unsandboxed && !capabilities.unsandboxed)
    return refuse('UNSUPPORTED', 'This runtime cannot run a command without its sandbox. Nothing was run.');
  if (input.tty && !runtime.writeStdin)
    return refuse('UNSUPPORTED', 'This runtime does not support sessions. Nothing was run.');
  return undefined;
}

function buildRequest(
  input: ExecInput,
  cwd: string,
  sandbox: CommandSandbox,
  shell: 'bash' | 'sh',
  sessions: boolean,
): CommandRequest {
  return {
    command: input.cmd,
    cwd,
    sandbox,
    tty: input.tty === true,
    shell,
    login: input.login === true,
    timeoutMs: input.timeout_ms ?? (sessions ? EXEC_LIMITS.defaultLeaseMs : EXEC_LIMITS.defaultTimeoutMs),
    // Codex: every launch yields after yield_time_ms; a command still running then is a session, not a timeout.
    yieldTimeMs: sessions ? clampYield(input.yield_time_ms, EXEC_LIMITS.defaultYieldMs) : undefined,
    maxOutputBytes: (input.max_output_tokens ?? EXEC_LIMITS.defaultOutputTokens) * EXEC_LIMITS.bytesPerToken,
  };
}
