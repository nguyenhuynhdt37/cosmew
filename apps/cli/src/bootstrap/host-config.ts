import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {FutrynError, type Provider} from '@futryn/contracts';
import {
  appendProvider,
  loadHostConfig,
  loadHostPermissions,
  type HostPermissionConfig,
  removeProvider,
  type HostConfigDiagnostic,
  type HostProviderEntry,
  type TokenCommand,
} from '@futryn/models';

/**
 * The user-level host config (ADR 0046): `<state directory>/config.toml`. It is read from the state
 * directory only. A workspace never contributes providers, so a cloned repository cannot point
 * prompts at its own host or make Futryn run its commands.
 */
const MAX_BYTES = 256 * 1024;

export interface LoadedHostConfig {
  path: string;
  providers: HostProviderEntry[];
  /** Permission defaults (`sandbox_mode`, `approval_policy`, `[sandbox_workspace_write]`; ADR 0055). */
  permissions: HostPermissionConfig;
  diagnostics: HostConfigDiagnostic[];
  /** False when the file exists but could not be used as a whole (unsafe, unreadable, not TOML). */
  usable: boolean;
}

export class HostConfigStore {
  readonly path: string;
  constructor(
    directory: string,
    private readonly reserved: ReadonlySet<string> = new Set(),
  ) {
    this.path = join(directory, 'config.toml');
  }

  private readText(): {text: string} | {error: string} | null {
    let stat;
    try {
      stat = lstatSync(this.path);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) return {error: 'config.toml must be a regular file, not a link'};
    if (stat.size > MAX_BYTES) return {error: 'config.toml is larger than 256 KiB'};
    if (process.platform !== 'win32') {
      if (process.getuid && stat.uid !== process.getuid()) return {error: 'config.toml is owned by another user'};
      if (stat.mode & 0o022) return {error: 'config.toml is writable by other users; run chmod go-w on it'};
    }
    try {
      return {text: readFileSync(this.path, 'utf8')};
    } catch {
      return {error: 'config.toml could not be read'};
    }
  }

  load(): LoadedHostConfig {
    const base = {
      path: this.path,
      providers: [],
      permissions: {diagnostics: []} as HostPermissionConfig,
      diagnostics: [] as HostConfigDiagnostic[],
    };
    const read = this.readText();
    if (!read) return {...base, usable: true};
    if ('error' in read) return {...base, diagnostics: [{message: read.error}], usable: false};
    let parsed: unknown;
    try {
      parsed = Bun.TOML.parse(read.text);
    } catch {
      return {...base, diagnostics: [{message: 'config.toml is not valid TOML'}], usable: false};
    }
    const config = loadHostConfig(parsed, this.reserved);
    const permissions = loadHostPermissions(parsed);
    return {
      path: this.path,
      providers: config.providers,
      permissions,
      diagnostics: [...config.diagnostics, ...permissions.diagnostics],
      usable: true,
    };
  }

  private write(text: string): void {
    // Atomic replace so a crash cannot leave a half-written config; owner-only like the rest of the state.
    const temp = `${this.path}.${process.pid}.tmp`;
    const fd = openSync(temp, constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.path);
    chmodSync(this.path, 0o600);
  }

  /** Add one provider table; refuses an id that is already defined or a file that is not usable. */
  add(entry: HostProviderEntry): void {
    const read = this.readText();
    if (read && 'error' in read) throw new FutrynError('STORAGE');
    try {
      this.write(appendProvider(read ? read.text : '', entry));
    } catch (error) {
      throw error instanceof FutrynError ? error : new FutrynError('INVALID_INPUT');
    }
  }

  remove(id: string): boolean {
    const read = this.readText();
    if (!read) return false;
    if ('error' in read) throw new FutrynError('STORAGE');
    const next = removeProvider(read.text, id);
    if (next === read.text) return false;
    this.write(next);
    return true;
  }
}

/**
 * Runs a provider's token command (Codex `auth`): an executable started directly, never through a
 * shell, with a hard timeout and a bounded stdout. The token is cached for `refreshIntervalMs`, never
 * logged, and handed to the redactor so it cannot reach output or storage.
 */
export class TokenCommandRunner {
  /** One entry per provider, valid only for the exact destination and command it was fetched for. */
  private readonly cache = new Map<string, {fingerprint: string; token: string; at: number}>();
  constructor(
    private readonly commands: (providerId: string) => TokenCommand | undefined,
    private readonly redact: (token: string) => void,
    private readonly now: () => number = Date.now,
    private readonly cwd: string = process.env.HOME ?? process.cwd(),
  ) {}

  async token(provider: Provider, signal?: AbortSignal): Promise<string | undefined> {
    const command = this.commands(provider.id);
    if (!command) return undefined;
    // A token is bound to {id, base_url, command, args, env_key}: if the config changes any of them the
    // cached token is never sent to the new destination and the command runs again.
    const fingerprint = new Bun.CryptoHasher('sha256')
      .update(JSON.stringify([provider.id, provider.baseURL, command.command, command.args, provider.envKey ?? null]))
      .digest('hex');
    const cached = this.cache.get(provider.id);
    if (
      cached &&
      cached.fingerprint === fingerprint &&
      command.refreshIntervalMs > 0 &&
      this.now() - cached.at < command.refreshIntervalMs
    )
      return cached.token;
    this.cache.delete(provider.id);
    const token = await this.run(command, signal);
    this.cache.set(provider.id, {fingerprint, token, at: this.now()});
    return token;
  }

  /** Forget the cached token, e.g. after a 401, so the next request reruns the command. */
  invalidate(providerId: string): void {
    this.cache.delete(providerId);
  }

  private async run(command: TokenCommand, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new FutrynError('CANCELLED');
    let child;
    try {
      child = Bun.spawn([command.command, ...command.args], {
        cwd: this.cwd,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        env: process.env as Record<string, string>,
      });
    } catch {
      throw new FutrynError('RUNTIME_UNAVAILABLE');
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), command.timeoutMs);
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, {once: true});
    try {
      const reader = child.stdout.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 16 * 1024) {
          child.kill('SIGKILL');
          throw new FutrynError('PROTOCOL');
        }
        chunks.push(part.value);
      }
      const code = await child.exited;
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      if (code !== 0) throw new FutrynError(child.signalCode ? 'TIMEOUT' : 'AUTH');
      const token = Buffer.concat(chunks).toString('utf8').trim();
      if (!token || /[\r\n\x00-\x1f\x7f\s]/.test(token)) throw new FutrynError('PROTOCOL');
      this.redact(token);
      return token;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}
