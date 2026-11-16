import {DockerCommandRuntime} from './container';
import {NativeCommandRuntime} from './native';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { SECRET_FILE_EXCEPTIONS, SECRET_FILE_RULES } from '@futryn/security';
import { ProcessSupervisor } from './process';
import type { CommandRequest, CommandOutcome, CommandRuntime, RuntimeAvailability } from '@futryn/contracts';

/** Used on platforms without a tested sandbox: the tool is never offered and nothing runs. */
export class UnsupportedRuntime implements CommandRuntime {
  readonly id = 'unsupported';
  readonly label = 'no sandbox available';
  constructor(private readonly reason: string) {}
  availability(): RuntimeAvailability { return { ok: false, reason: this.reason }; }
  async run(): Promise<CommandOutcome> { throw new Error('UnsupportedRuntime.run must not be called'); }
}

/** Case-insensitive SBPL regex fragment for a literal file-name piece. */
const ci = (text: string) => [...text].map(ch => /[a-z]/i.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch).join('');

/** SBPL regexes over absolute paths for every secret-looking file name of the read policy. */
export function secretPathRegexes(): { deny: string[]; except: string[] } {
  const deny = SECRET_FILE_RULES.map(rule => rule.match === 'exact' ? `/${ci(rule.value)}$`
    : rule.match === 'prefix' ? `/${ci(rule.value)}[^/]${rule.value.endsWith('.') ? '+' : '*'}$`
    : `${ci(rule.value)}$`);
  return { deny, except: SECRET_FILE_EXCEPTIONS.map(name => `/${ci(name)}$`) };
}

const SYSTEM_READ = ['/usr', '/bin', '/sbin', '/System', '/Library/Apple', '/private/etc', '/private/var/db/timezone'];
const SYSTEM_EXEC_MAPS = ['/usr/lib', '/System/Library', '/Library/Apple'];

export interface SeatbeltOptions {
  /** Canonical workspace root; the only user tree the command may read. */
  workspaceRoot: string;
  /** Futryn's state directory; always denied, even if it lies inside the workspace. */
  stateDirectory?: string;
  /** Extra programs (by name, looked up on the host PATH) the sandbox may execute, e.g. `rg`. */
  extraExecutables?: string[];
  /** Override for tests; production always uses the system binary, never PATH. */
  sandboxExec?: string;
  platform?: NodeJS.Platform;
  container?:boolean;
  hostPath?: string;
}

/**
 * macOS Seatbelt runtime (ADR 0022), modelled on Codex's `sandbox-exec` launcher: deny by default,
 * read-only, no network, reads limited to system locations, the workspace and named executables;
 * Futryn state, `.git` internals and secret-looking files are denied. The shell is
 * `bash --noprofile --norc` with a fixed environment, so project files cannot inject startup code.
 */
export class SeatbeltRuntime implements CommandRuntime {
  private readonly supervisor = new ProcessSupervisor();
  readonly id: string;
  readonly label = 'macOS Seatbelt · read-only · no network';
  private readonly profile: string;
  private readonly params: string[];
  private readonly path: string;
  private readonly sandboxExec: string;
  private probed: RuntimeAvailability | undefined;

  constructor(private readonly options: SeatbeltOptions) {
    this.sandboxExec = options.sandboxExec ?? '/usr/bin/sandbox-exec';
    const executables = (options.extraExecutables ?? []).flatMap(name => {
      for (const dir of (options.hostPath ?? process.env.PATH ?? '').split(delimiter)) {
        const candidate = join(dir, name);
        try { if (dir && statSync(candidate).isFile()) return [{ link: candidate, real: realpathSync.native(candidate) }]; } catch { /* next */ }
      }
      return [];
    });
    const { deny, except } = secretPathRegexes();
    const lines = [
      '(version 1)',
      '(deny default)',
      '(allow process-exec process-fork)',
      '(allow signal (target same-sandbox))',
      '(allow process-info* (target same-sandbox))',
      '(allow sysctl-read)',
      `(allow file-read* file-test-existence (literal "/") ${SYSTEM_READ.map(p => `(subpath "${p}")`).join(' ')})`,
      `(allow file-map-executable ${SYSTEM_EXEC_MAPS.map(p => `(subpath "${p}")`).join(' ')})`,
      '(allow file-read-metadata file-test-existence (literal "/etc") (literal "/var") (literal "/tmp") (literal "/private") (literal "/private/var") (literal "/dev"))',
      '(allow file-read* file-test-existence (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (subpath "/dev/fd"))',
      '(allow file-write-data (require-all (path "/dev/null") (vnode-type CHARACTER-DEVICE)))',
      '(allow file-read* file-test-existence (subpath (param "WORKSPACE")))',
      '(allow file-read-metadata file-test-existence (path-ancestors (param "WORKSPACE")))',
      ...executables.flatMap((_exe, i) => [
        `(allow file-read* file-test-existence file-map-executable (literal (param "EXE${i}")) (literal (param "EXELINK${i}")))`,
      ]),
      // Denials come last so they win over the allowances above.
      ...(options.stateDirectory ? ['(deny file-read* file-write* file-test-existence (subpath (param "STATE")))'] : []),
      '(deny file-read* (regex #"/\\.[gG][iI][tT](/|$)"))',
      `(deny file-read* (require-all (require-any ${deny.map(r => `(regex #"${r}")`).join(' ')}) ${except.map(r => `(require-not (regex #"${r}"))`).join(' ')}))`,
    ];
    this.profile = lines.join('\n');
    this.params = [`-DWORKSPACE=${options.workspaceRoot}`, ...(options.stateDirectory ? [`-DSTATE=${options.stateDirectory}`] : []),
      ...executables.flatMap((exe, i) => [`-DEXE${i}=${exe.real}`, `-DEXELINK${i}=${exe.link}`])];
    this.path = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', ...new Set(executables.map(exe => dirname(exe.link)))].join(':');
    this.id = 'macos-seatbelt-readonly-v1:' + createHash('sha256').update(JSON.stringify([this.profile, this.params, this.path])).digest('hex').slice(0, 16);
  }

  /** The exact profile text, for audit and tests. */
  policyText(): string { return this.profile; }

  private env(): Record<string, string> {
    return { PATH: this.path, HOME: '/var/empty', LANG: 'en_US.UTF-8', TERM: 'dumb', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' };
  }

  private argv(command: string): [string, ...string[]] {
    return [this.sandboxExec, '-p', this.profile, ...this.params, '/bin/bash', '--noprofile', '--norc', '-c', command];
  }

  /**
   * Production stays closed even when the isolation-only probe passes: process-group cleanup
   * cannot contain a detached/reparented descendant. ADR 0022 records the real OS reproducer.
   */
  availability(): RuntimeAvailability {
    return {ok:false, reason:'Task 03B security gate closed: no enforceable descendant lifetime boundary has been verified. No production commands are enabled.'};
  }

  /** Isolation research only. This probe does not certify descendant cleanup or enable the tool. */
  probeIsolation(): RuntimeAvailability {
    if (this.probed) return this.probed;
    if ((this.options.platform ?? process.platform) !== 'darwin') return this.probed = { ok: false, reason: 'Seatbelt is only available on macOS.' };
    if (!existsSync(this.sandboxExec)) return this.probed = { ok: false, reason: `${this.sandboxExec} is missing.` };
    const [file, ...args] = this.argv('/bin/test -r /bin/ls && ! /bin/ls "$0" >/dev/null 2>&1');
    const probe = spawnSync(file, [...args, homedir()], { cwd: this.options.workspaceRoot, env: this.env(), timeout: 5000, encoding: 'utf8' });
    if (probe.status !== 0) return this.probed = { ok: false, reason: probe.stderr?.startsWith('sandbox-exec:') ? 'The sandbox profile was rejected.' : 'The sandbox self-test failed.' };
    return this.probed = { ok: true };
  }

  async run(request: CommandRequest, signal?: AbortSignal): Promise<CommandOutcome> {
    const outcome = await this.supervisor.run({ argv: this.argv(request.command), cwd: request.cwd, env: this.env(), timeoutMs: request.timeoutMs, maxOutputBytes: request.maxOutputBytes }, signal);
    const result = {...outcome, output:outcome.output.text(), omittedBytes:outcome.output.omittedBytes};
    // sandbox-exec reports its own failures (e.g. a rejected profile) on stderr with status 65.
    if (outcome.kind === 'exited' && outcome.exitCode === 65 && outcome.output.text().startsWith('sandbox-exec:')) return { ...result, sandboxFailed: true };
    if (outcome.kind === 'spawn-failed') return { ...result, sandboxFailed: true };
    return result;
  }

  async shutdown(): Promise<void> { await this.supervisor.shutdown(); }
}

/**
 * The runtime for this host (ADR 0035, Codex model): the native OS sandbox by default (macOS
 * Seatbelt, Linux bubblewrap); Docker only when explicitly selected; Windows is not implemented.
 */
export function platformCommandRuntime(options: SeatbeltOptions & {backend?: 'native' | 'docker'; hideSecrets?: boolean}): CommandRuntime {
  const platform = options.platform ?? process.platform;
  if ((options.backend === 'docker' || options.container) && ['darwin','linux'].includes(platform)) return new DockerCommandRuntime(options);
  return new NativeCommandRuntime({workspaceRoot: options.workspaceRoot, stateDirectory: options.stateDirectory, platform, hostPath: options.hostPath, hideSecrets: options.hideSecrets});
}

/** FUTRYN_COMMAND_BACKEND: `native` (default, also `auto`), `docker`, or `none`. Unknown values disable commands. */
export function commandBackendFromEnv(value: string | undefined): 'docker' | 'native' | 'none' {
  if (value === undefined || value === '' || value === 'auto' || value === 'native') return 'native';
  return value === 'docker' ? 'docker' : 'none';
}
