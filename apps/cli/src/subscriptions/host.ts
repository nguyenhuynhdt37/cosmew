import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {
  FutrynError,
  type InlineToolExecutor,
  type Account,
  type CredentialRef,
  type CredentialVault,
  type ModelEvent,
  type ModelInfo,
  type ModelRequest,
  type Provider,
  type ProviderAuthChallenge,
  type ProviderAuthProgress,
  type SettingsStore,
  type SubscriptionRuntime,
} from '@futryn/contracts';
import {normalizeModel} from '@futryn/models';
import {RuntimeProfile, type RuntimeLeases} from '@futryn/persistence';
import {
  authorizeSubscription,
  subscriptionEnvironment,
  subscriptionWorkspaceEnvironment,
  type SubscriptionRecipe,
} from '@futryn/security';

import {SubscriptionRpc} from './rpc';
import {RuntimeTurn, type Connection, type RuntimeApprover} from './runtime-turn';

export type {RuntimeApprover} from './runtime-turn';

/** Futryn-owned tools the Codex bridge may expose; each call still runs through the Futryn dispatcher (ADR 0018, 0022). */
const HANNES_BRIDGE_TOOLS = [
  'read',
  'glob',
  'grep',
  'exec_command',
  'write_stdin',
  'apply_patch',
  'edit',
  'write',
  'request_permissions',
  'update_plan',
  'request_user_input',
  'lsp',
  'lsp_rename',
  'web_search',
  'web_fetch',
];

type RuntimeRef = Extract<CredentialRef, {kind: 'runtime'}>;
interface Login {
  provider: Provider;
  profile: RuntimeProfile;
  rpc?: SubscriptionRpc;
  child?: ChildProcessWithoutNullStreams;
  openedURL?: string;
  progress: ProviderAuthProgress;
  expires: number;
  timer: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
  done: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  error?: FutrynError;
}
export interface SubscriptionHostOptions {
  /** Runtimes use their own tools in the consented workspace, asking Futryn for permission (ADR 0027). Default true; false keeps the chat-only/Codex-bridge behavior. */
  nativeRuntimeTools?: boolean;
  openURL?(url: string): Promise<void>;
  resolveCommand?(runtime: SubscriptionRuntime): {command: string; prefix?: string[]} | undefined;
}

export class SubscriptionHost {
  private readonly logins = new Map<string, Login>();
  private readonly busyAccounts = new Set<string>();
  private readonly active = new Map<string, Set<SubscriptionRpc>>();
  constructor(
    private readonly root: string,
    private readonly vault: CredentialVault,
    private readonly settings: SettingsStore,
    private readonly leases: RuntimeLeases,
    private readonly options: SubscriptionHostOptions = {},
  ) {}

  private executable(recipe: SubscriptionRecipe) {
    const found = this.options.resolveCommand
      ? this.options.resolveCommand(recipe.runtime)
      : (() => {
          const command = Bun.which(recipe.command);
          return command ? {command, prefix: [] as string[]} : undefined;
        })();
    if (!found) throw new FutrynError('RUNTIME_UNAVAILABLE');
    return {command: found.command, prefix: found.prefix ?? []};
  }
  available(provider: Provider): boolean {
    try {
      this.executable(authorizeSubscription(provider));
      return true;
    } catch {
      return false;
    }
  }
  private assertAccount(account: Account): void {
    const fresh = this.settings.read().accounts.find(a => a.id === account.id);
    if (
      !fresh ||
      fresh.status === 'logged-out' ||
      fresh.authGeneration !== account.authGeneration ||
      JSON.stringify(fresh.credential) !== JSON.stringify(account.credential)
    )
      throw new FutrynError('POLICY');
  }
  private async initialize(rpc: SubscriptionRpc, recipe: SubscriptionRecipe) {
    if (recipe.runtime === 'codex') {
      const init = await rpc.request('initialize', {
        capabilities: {experimentalApi: true},
        clientInfo: {name: 'futryn', title: 'FUTRYN', version: '0.1.0'},
      });
      if (!init || typeof init !== 'object') throw new FutrynError('PROTOCOL');
      rpc.notify('initialized');
    } else if (recipe.runtime === 'copilot') {
      const result = await rpc.request('ping', {message: 'FUTRYN'});
      if (!Number.isInteger(result?.protocolVersion)) throw new FutrynError('UNSUPPORTED');
    } else {
      const init = await rpc.request('initialize', {
        protocolVersion: 1,
        clientInfo: {name: 'futryn', version: '0.1.0'},
        clientCapabilities: {},
      });
      if (init?.protocolVersion !== 1) throw new FutrynError('UNSUPPORTED');
    }
  }
  private authDiagnostic(login: Login, line: string): void {
    // Only recognized authorization links and public device codes are forwarded.
    const links = line.match(/https:\/\/[^\s"'<>\x1b]+/g) ?? [];
    for (const link of links) {
      try {
        const url = new URL(link);
        if (
          [
            'github.com',
            'accounts.google.com',
            'auth.openai.com',
            'chatgpt.com',
            'auth.qwen.ai',
            'chat.qwen.ai',
            'auth.x.ai',
            'accounts.x.ai',
          ].includes(url.hostname) &&
          !url.searchParams.has('access_token') &&
          !url.searchParams.has('id_token')
        ) {
          login.progress.authorizationURL = url.href;
          if (login.openedURL !== url.href) {
            login.openedURL = url.href;
            void this.openURL(url.href).catch(() => {
              login.progress.message = 'Open the URL below to finish signing in.';
            });
          }
        }
      } catch {
        /* ignore diagnostics */
      }
    }
    const code = /\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/.exec(line)?.[0];
    if (code) login.progress.userCode = code;
  }
  private async openURL(url: string): Promise<void> {
    if (this.options.openURL) return this.options.openURL(url);
    const executable =
      process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, {stdio: 'ignore', shell: false});
      child.once('error', reject);
      child.once('exit', code => (code === 0 ? resolve() : reject(new FutrynError('TRANSPORT'))));
    });
  }
  async begin(provider: Provider, device = false, signal?: AbortSignal): Promise<ProviderAuthChallenge> {
    if (signal?.aborted) throw new FutrynError('CANCELLED');
    if (!this.vault.setRuntime || !this.vault.getRuntime) throw new FutrynError('STORAGE');
    if (this.logins.size >= 8) throw new FutrynError('POLICY');
    const recipe = authorizeSubscription(provider);
    const executable = this.executable(recipe);
    const profile = new RuntimeProfile(this.root, recipe.credentialFiles, recipe.settingsFiles);
    const id = crypto.randomUUID();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void done.catch(() => {});
    const login: Login = {
      provider,
      profile,
      progress: {state: 'pending', message: `Complete ${provider.name} sign-in in your browser.`},
      expires: Date.now() + 600000,
      timer: setTimeout(() => {
        void this.cancel(id);
      }, 600000),
      done,
      resolve,
      reject,
    };
    this.logins.set(id, login);
    const abort = () => {
      void this.cancel(id);
    };
    signal?.addEventListener('abort', abort, {once: true});
    const succeed = () => {
      login.progress.state = 'ready';
      login.resolve();
    };
    const fail = (error: unknown) => {
      login.error = error instanceof FutrynError ? error : new FutrynError('AUTH');
      login.progress.state = 'failed';
      login.progress.message = login.error.message;
      login.reject(login.error);
    };
    try {
      const env = subscriptionEnvironment(recipe, profile.directory);
      if (recipe.runtime === 'copilot') {
        const child = spawn(executable.command, [...executable.prefix, 'login', '--device-code'], {
          cwd: profile.workspace,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        });
        login.child = child;
        let remaining = '';
        const output = (chunk: Buffer) => {
          remaining = (remaining + chunk.toString('utf8')).slice(-16384);
          const lines = remaining.split(/[\r\n]/);
          remaining = lines.pop() ?? '';
          for (const line of lines) this.authDiagnostic(login, line);
        };
        child.stdout.on('data', output);
        child.stderr.on('data', output);
        child.on('error', () => fail(new FutrynError('NOT_FOUND')));
        child.on('exit', code => (code === 0 ? succeed() : fail(new FutrynError('AUTH'))));
      } else {
        const rpc = new SubscriptionRpc(
          executable.command,
          [...executable.prefix, ...recipe.args],
          env,
          profile.workspace,
          recipe.framing,
          line => this.authDiagnostic(login, line),
        );
        login.rpc = rpc;
        rpc.onMessage(message => {
          if (message.method === 'account/login/completed')
            message.params?.success ? succeed() : fail(new FutrynError('AUTH'));
          if (message.method?.endsWith('authenticate/update')) {
            const url = message.params?._meta?.authUri;
            if (typeof url === 'string') this.authDiagnostic(login, url);
          }
          if (message.method === '__closed' && login.progress.state === 'pending') fail(new FutrynError('TRANSPORT'));
        });
        await this.initialize(rpc, recipe);
        if (recipe.runtime === 'codex') {
          const started = await rpc.request('account/login/start', {type: device ? 'chatgptDeviceCode' : 'chatgpt'});
          this.authDiagnostic(login, String(started?.authUrl ?? started?.verificationUrl ?? ''));
          if (typeof started?.userCode === 'string' && /^[A-Z0-9-]{4,32}$/.test(started.userCode))
            login.progress.userCode = started.userCode;
          if (typeof started?.loginId !== 'string') throw new FutrynError('PROTOCOL');
        } else {
          void rpc.request('authenticate', {methodId: recipe.authMethod}, 600000).then(succeed, fail);
        }
      }
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      return {
        id,
        authorizationURL: login.progress.authorizationURL ?? '',
        userCode: login.progress.userCode,
        message: login.progress.message,
        expiresAt: new Date(login.expires).toISOString(),
        autoComplete: true,
      };
    } catch (error) {
      await this.cancel(id);
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  progress(id: string): ProviderAuthProgress {
    const login = this.logins.get(id);
    if (!login) throw new FutrynError('NOT_FOUND');
    if (Date.now() >= login.expires) throw new FutrynError('AUTH');
    return {...login.progress};
  }
  async complete(provider: Provider, id: string, signal?: AbortSignal): Promise<RuntimeRef> {
    const login = this.logins.get(id);
    if (!login || JSON.stringify(login.provider) !== JSON.stringify(provider)) throw new FutrynError('POLICY');
    const abort = () => {
      void this.cancel(id);
    };
    signal?.addEventListener('abort', abort, {once: true});
    let key: string | undefined;
    try {
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      await login.done;
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      await login.rpc?.close();
      const snapshot = login.profile.snapshot();
      key = crypto.randomUUID();
      await this.vault.setRuntime!(key, snapshot);
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      return {kind: 'runtime', key, runtime: provider.runtime!};
    } catch (error) {
      if (key) await this.vault.delete({kind: 'runtime', key, runtime: provider.runtime!});
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      await this.cancel(id);
    }
  }
  async cancel(id: string): Promise<void> {
    const login = this.logins.get(id);
    if (!login) return;
    if (login.closing) return login.closing;
    clearTimeout(login.timer);
    login.progress.state = 'failed';
    login.reject(new FutrynError('CANCELLED'));
    login.closing = (async () => {
      await login.rpc?.close();
      if (login.child && login.child.exitCode === null && login.child.signalCode === null) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => login.child!.kill('SIGKILL'), 500);
          login.child!.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
          login.child!.kill();
        });
      }
      login.profile.close();
      this.logins.delete(id);
    })();
    return login.closing;
  }
  /** `workspace`: consented project root for a runtime with a full-access mode (ADR 0027). */
  private async connect(provider: Provider, account: Account, workspace?: string): Promise<Connection> {
    this.assertAccount(account);
    if (this.busyAccounts.has(account.id)) throw new FutrynError('POLICY');
    if (account.credential.kind !== 'runtime' || account.credential.runtime !== provider.runtime)
      throw new FutrynError('POLICY');
    const recipe = authorizeSubscription(provider);
    const executable = this.executable(recipe);
    const lease = this.leases.acquire(account.id);
    this.busyAccounts.add(account.id);
    let profile: RuntimeProfile | undefined;
    let rpc: SubscriptionRpc | undefined;
    try {
      const record = await this.vault.getRuntime?.(account.credential);
      if (!record) throw new FutrynError('AUTH');
      this.assertAccount(account);
      const native =
        workspace && recipe.workspace && this.options.nativeRuntimeTools !== false ? recipe.workspace : undefined;
      profile = new RuntimeProfile(
        this.root,
        recipe.credentialFiles,
        native?.settingsFiles ?? recipe.settingsFiles,
        record,
      );
      rpc = new SubscriptionRpc(
        executable.command,
        [...executable.prefix, ...(native?.args ?? recipe.args)],
        native
          ? subscriptionWorkspaceEnvironment(recipe, profile.directory)
          : subscriptionEnvironment(recipe, profile.directory),
        native ? workspace! : profile.workspace,
        recipe.framing,
      );
      const active = this.active.get(account.id) ?? new Set<SubscriptionRpc>();
      active.add(rpc);
      this.active.set(account.id, active);
      await this.initialize(rpc, recipe);
      if (recipe.runtime === 'codex') {
        const state = await rpc.request('account/read', {refreshToken: true});
        if (state?.account?.type !== 'chatgpt') throw new FutrynError('AUTH');
      } else if (recipe.runtime === 'copilot') {
        const state = await rpc.request('auth.getStatus');
        if (state?.isAuthenticated !== true) throw new FutrynError('AUTH');
      } else if (recipe.runtime === 'gemini-cli' || recipe.runtime === 'grok-build')
        await rpc.request('authenticate', {methodId: recipe.authMethod});
      this.assertAccount(account);
      return {profile, rpc, recipe, lease, cwd: native ? workspace! : profile.workspace, native: !!native};
    } catch (error) {
      await rpc?.close();
      profile?.close();
      if (rpc) this.active.get(account.id)?.delete(rpc);
      this.busyAccounts.delete(account.id);
      this.leases.release(account.id, lease);
      throw error;
    }
  }
  private async close(connection: Connection, account: Account): Promise<void> {
    try {
      await connection.rpc.close();
      this.assertAccount(account);
      if (account.credential.kind !== 'runtime') throw new FutrynError('POLICY');
      await this.vault.setRuntime!(account.credential.key, connection.profile.snapshot());
      try {
        this.assertAccount(account);
      } catch (error) {
        await this.vault.delete(account.credential);
        throw error;
      }
    } finally {
      this.busyAccounts.delete(account.id);
      this.active.get(account.id)?.delete(connection.rpc);
      connection.profile.close();
      this.leases.release(account.id, connection.lease);
    }
  }
  private acpModels(result: any): ModelInfo[] {
    const models =
      result?.models?.availableModels ??
      result?._meta?.models?.availableModels ??
      result?._meta?.modelState?.availableModels;
    if (Array.isArray(models) && models.length <= 10000) return models.map(m => normalizeModel(m.modelId, m.name));
    const option = result?.configOptions?.find((o: any) => o.category === 'model' || o.id === 'model');
    if (Array.isArray(option?.options)) return option.options.map((m: any) => normalizeModel(m.value, m.name));
    throw new FutrynError('PROTOCOL');
  }
  private runtimeModel(raw: any, runtime: 'codex' | 'copilot'): ModelInfo {
    // Codex exposes a catalog entry id separately from the model slug accepted by turns.
    const model = normalizeModel(runtime === 'codex' ? (raw.model ?? raw.id) : raw.id, raw.displayName ?? raw.name);
    const efforts = raw.supportedReasoningEfforts;
    if (Array.isArray(efforts) && efforts.length <= 20) {
      const values = efforts.map((entry: any) => (runtime === 'codex' ? entry.reasoningEffort : entry));
      if (values.every((value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 40))
        model.reasoningEfforts = values;
      if (model.reasoningEfforts?.length) model.capabilities.reasoning = 'supported';
    }
    if (typeof raw.defaultReasoningEffort === 'string' && model.reasoningEfforts?.includes(raw.defaultReasoningEffort))
      model.defaultReasoningEffort = raw.defaultReasoningEffort;
    const limits = raw.capabilities?.limits;
    if (runtime === 'copilot' && limits) {
      if (Number.isInteger(limits.max_context_window_tokens) && limits.max_context_window_tokens > 0)
        model.contextLimit = limits.max_context_window_tokens;
      if (Number.isInteger(limits.max_output_tokens) && limits.max_output_tokens > 0)
        model.outputLimit = limits.max_output_tokens;
    }
    model.metadataSource = runtime + ':model/list';
    model.metadataFetchedAt = model.fetchedAt;
    return model;
  }
  async models(provider: Provider, account: Account, signal?: AbortSignal): Promise<ModelInfo[]> {
    const connection = await this.connect(provider, account);
    const abort = () => {
      void connection.rpc.close();
    };
    signal?.addEventListener('abort', abort, {once: true});
    try {
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      let models: ModelInfo[];
      if (connection.recipe.runtime === 'codex') {
        const result = await connection.rpc.request('model/list', {limit: 100});
        if (!Array.isArray(result?.data) || result.nextCursor) throw new FutrynError('PROTOCOL');
        models = result.data.filter((m: any) => m.hidden !== true).map((m: any) => this.runtimeModel(m, 'codex'));
      } else if (connection.recipe.runtime === 'copilot') {
        const result = await connection.rpc.request('models.list');
        const list = result?.models ?? result;
        if (!Array.isArray(list)) throw new FutrynError('PROTOCOL');
        models = list.map(m => this.runtimeModel(m, 'copilot'));
      } else {
        models = this.acpModels(
          await connection.rpc.request('session/new', {cwd: connection.profile.workspace, mcpServers: []}),
        );
      }
      this.assertAccount(account);
      if (!models.length) throw new FutrynError('NOT_FOUND');
      return models;
    } finally {
      signal?.removeEventListener('abort', abort);
      await this.close(connection, account);
    }
  }
  /**
   * One model turn on the account's runtime. Requests the runtime cannot honor are refused before
   * anything starts; the turn itself is a RuntimeTurn whose events are yielded until it ends.
   */
  async *stream(
    provider: Provider,
    account: Account,
    request: ModelRequest,
    signal?: AbortSignal,
    executeTool?: InlineToolExecutor,
    workspaceRoot?: string,
    nativeWorkspace?: string,
    approve?: RuntimeApprover,
  ): AsyncIterable<ModelEvent> {
    // Only the Codex bridge receives tools, and only Futryn's own bridge tools.
    const unsupportedTools =
      provider.runtime !== 'codex' || !executeTool || request.tools.some(t => !HANNES_BRIDGE_TOOLS.includes(t.name));
    if (request.tools.length && unsupportedTools) throw new FutrynError('UNSUPPORTED');
    if (request.reasoningEffort && !this.supportsEffort(account, request.modelId, request.reasoningEffort)) {
      throw new FutrynError('UNSUPPORTED');
    }

    const connection = await this.connect(provider, account, nativeWorkspace);
    const turn = new RuntimeTurn({
      provider,
      account,
      connection,
      request,
      signal,
      executeTool,
      workspaceRoot,
      approve,
      assertAccount: a => this.assertAccount(a),
      acpModels: session => this.acpModels(session),
    });
    turn.attach();
    try {
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      yield {type: 'started', requestId: request.requestId};
      await turn.start();
      while (!turn.terminal || turn.queue.length) {
        if (turn.error) throw turn.error;
        if (turn.queue.length) yield turn.queue.shift()!;
        else await turn.next();
      }
      if (turn.error) throw turn.error;
      this.assertAccount(account);
      if (!turn.bytes) throw new FutrynError('PROTOCOL');
      yield {type: 'completed', finishReason: 'stop', usage: turn.usage};
    } catch (cause) {
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      throw cause;
    } finally {
      await turn.detach();
      await this.close(connection, account);
    }
  }

  private supportsEffort(account: Account, modelId: string, effort: string): boolean {
    return !!this.settings
      .read()
      .catalogs.find(c => c.accountId === account.id)
      ?.models.find(m => m.id === modelId)
      ?.reasoningEfforts?.includes(effort);
  }

  async revoke(account: Account): Promise<void> {
    await Promise.all([...(this.active.get(account.id) ?? [])].map(rpc => rpc.close()));
  }
  async shutdown(): Promise<void> {
    await Promise.all([...this.logins.keys()].map(id => this.cancel(id)));
    await Promise.all([...this.active.values()].flatMap(set => [...set].map(rpc => rpc.close())));
  }
}
