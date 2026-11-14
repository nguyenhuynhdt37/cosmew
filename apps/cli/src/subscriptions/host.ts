import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { HannesError, type Account, type CredentialRef, type CredentialVault, type ModelEvent, type ModelInfo, type ModelRequest, type Provider, type ProviderAuthChallenge, type ProviderAuthProgress, type SettingsStore, type SubscriptionRuntime } from '@hannes/contracts';
import { normalizeModel } from '@hannes/models';
import { RuntimeProfile, type RuntimeLeases } from '@hannes/persistence';
import { authorizeSubscription, subscriptionEnvironment, type SubscriptionRecipe } from '@hannes/security';
import { SubscriptionRpc, type RpcMessage } from './rpc';

type RuntimeRef = Extract<CredentialRef, {kind:'runtime'}>;
type Connection = { lease: string; profile: RuntimeProfile; rpc: SubscriptionRpc; recipe: SubscriptionRecipe };
interface Login {
  provider: Provider; profile: RuntimeProfile; rpc?: SubscriptionRpc; child?: ChildProcessWithoutNullStreams;
  openedURL?: string; progress: ProviderAuthProgress; expires: number; timer: ReturnType<typeof setTimeout>;
  closing?: Promise<void>; done: Promise<void>; resolve(): void; reject(error: unknown): void; error?: HannesError;
}
export interface SubscriptionHostOptions { openURL?(url: string): Promise<void>; resolveCommand?(runtime: SubscriptionRuntime): { command: string; prefix?: string[] } | undefined }

export class SubscriptionHost {
  private readonly logins = new Map<string, Login>();
  private readonly busyAccounts = new Set<string>();
  private readonly active = new Map<string, Set<SubscriptionRpc>>();
  constructor(private readonly root: string, private readonly vault: CredentialVault, private readonly settings: SettingsStore, private readonly leases: RuntimeLeases, private readonly options: SubscriptionHostOptions = {}) {}

  private executable(recipe: SubscriptionRecipe) {
    const found = this.options.resolveCommand ? this.options.resolveCommand(recipe.runtime) : (() => { const command = Bun.which(recipe.command); return command ? { command, prefix: [] as string[] } : undefined; })();
    if (!found) throw new HannesError('RUNTIME_UNAVAILABLE');
    return { command: found.command, prefix: found.prefix ?? [] };
  }
  available(provider: Provider): boolean { try { this.executable(authorizeSubscription(provider)); return true; } catch { return false; } }
  private assertAccount(account: Account): void {
    const fresh = this.settings.read().accounts.find(a => a.id === account.id);
    if (!fresh || fresh.status === 'logged-out' || fresh.authGeneration !== account.authGeneration || JSON.stringify(fresh.credential) !== JSON.stringify(account.credential)) throw new HannesError('POLICY');
  }
  private async initialize(rpc: SubscriptionRpc, recipe: SubscriptionRecipe) {
    if (recipe.runtime === 'codex') {
      const init = await rpc.request('initialize', { clientInfo: { name: 'futryn', title: 'FUTRYN', version: '0.1.0' } });
      if (!init || typeof init !== 'object') throw new HannesError('PROTOCOL');
      rpc.notify('initialized');
    } else if (recipe.runtime === 'copilot') {
      const result = await rpc.request('ping', { message: 'FUTRYN' });
      if (!Number.isInteger(result?.protocolVersion)) throw new HannesError('UNSUPPORTED');
    } else {
      const init = await rpc.request('initialize', { protocolVersion: 1, clientInfo: { name: 'futryn', version: '0.1.0' }, clientCapabilities: {} });
      if (init?.protocolVersion !== 1) throw new HannesError('UNSUPPORTED');
    }
  }
  private authDiagnostic(login: Login, line: string): void {
    // Only recognized authorization links and public device codes are forwarded.
    const links = line.match(/https:\/\/[^\s"'<>\x1b]+/g) ?? [];
    for (const link of links) {
      try {
        const url = new URL(link);
        if (['github.com', 'accounts.google.com', 'auth.openai.com', 'chatgpt.com', 'auth.qwen.ai', 'chat.qwen.ai'].includes(url.hostname) && !url.searchParams.has('access_token') && !url.searchParams.has('id_token')) {
          login.progress.authorizationURL = url.href;
          if (login.openedURL !== url.href) { login.openedURL = url.href; void this.openURL(url.href).catch(() => { login.progress.message = 'Open the URL below to finish signing in.'; }); }
        }
      } catch { /* ignore diagnostics */ }
    }
    const code = /\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/.exec(line)?.[0];
    if (code) login.progress.userCode = code;
  }
  private async openURL(url: string): Promise<void> {
    if (this.options.openURL) return this.options.openURL(url);
    const executable = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { stdio: 'ignore', shell: false });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new HannesError('TRANSPORT')));
    });
  }
  async begin(provider: Provider, device = false, signal?: AbortSignal): Promise<ProviderAuthChallenge> {
    if (signal?.aborted) throw new HannesError('CANCELLED');
    if (!this.vault.setRuntime || !this.vault.getRuntime) throw new HannesError('STORAGE');
    if (this.logins.size >= 8) throw new HannesError('POLICY');
    const recipe = authorizeSubscription(provider);
    const executable = this.executable(recipe);
    const profile = new RuntimeProfile(this.root, recipe.credentialFiles, recipe.settingsFiles);
    const id = crypto.randomUUID();
    let resolve!: () => void; let reject!: (error: unknown) => void;
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void done.catch(() => {});
    const login: Login = { provider, profile, progress: { state: 'pending', message: `Complete ${provider.name} sign-in in your browser.` }, expires: Date.now() + 600000, timer: setTimeout(() => { void this.cancel(id); }, 600000), done, resolve, reject };
    this.logins.set(id, login);
    const abort = () => { void this.cancel(id); };
    signal?.addEventListener('abort', abort, { once: true });
    const succeed = () => { login.progress.state = 'ready'; login.resolve(); };
    const fail = (error: unknown) => { login.error = error instanceof HannesError ? error : new HannesError('AUTH'); login.progress.state = 'failed'; login.progress.message = login.error.message; login.reject(login.error); };
    try {
      const env = subscriptionEnvironment(recipe, profile.directory);
      if (recipe.runtime === 'copilot') {
        const child = spawn(executable.command, [...executable.prefix, 'login', '--device-code'], { cwd: profile.workspace, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
        login.child = child;
        let remaining = '';
        const output = (chunk: Buffer) => {
          remaining = (remaining + chunk.toString('utf8')).slice(-16384);
          const lines = remaining.split(/[\r\n]/); remaining = lines.pop() ?? '';
          for (const line of lines) this.authDiagnostic(login, line);
        };
        child.stdout.on('data', output); child.stderr.on('data', output);
        child.on('error', () => fail(new HannesError('NOT_FOUND')));
        child.on('exit', code => code === 0 ? succeed() : fail(new HannesError('AUTH')));
      } else {
        const rpc = new SubscriptionRpc(executable.command, [...executable.prefix, ...recipe.args], env, profile.workspace, recipe.framing, line => this.authDiagnostic(login, line));
        login.rpc = rpc;
        rpc.onMessage(message => {
          if (message.method === 'account/login/completed') message.params?.success ? succeed() : fail(new HannesError('AUTH'));
          if (message.method?.endsWith('authenticate/update')) {
            const url = message.params?._meta?.authUri;
            if (typeof url === 'string') this.authDiagnostic(login, url);
          }
          if (message.method === '__closed' && login.progress.state === 'pending') fail(new HannesError('TRANSPORT'));
        });
        await this.initialize(rpc, recipe);
        if (recipe.runtime === 'codex') {
          const started = await rpc.request('account/login/start', { type: device ? 'chatgptDeviceCode' : 'chatgpt' });
          this.authDiagnostic(login, String(started?.authUrl ?? started?.verificationUrl ?? ''));
          if (typeof started?.userCode === 'string' && /^[A-Z0-9-]{4,32}$/.test(started.userCode)) login.progress.userCode = started.userCode;
          if (typeof started?.loginId !== 'string') throw new HannesError('PROTOCOL');
        } else {
          void rpc.request('authenticate', { methodId: recipe.authMethod }, 600000).then(succeed, fail);
        }
      }
      if (signal?.aborted) throw new HannesError('CANCELLED');
      return { id, authorizationURL: login.progress.authorizationURL ?? '', userCode: login.progress.userCode, message: login.progress.message, expiresAt: new Date(login.expires).toISOString(), autoComplete: true };
    } catch (error) { await this.cancel(id); if (signal?.aborted) throw new HannesError('CANCELLED'); throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  }
  progress(id: string): ProviderAuthProgress {
    const login = this.logins.get(id);
    if (!login) throw new HannesError('NOT_FOUND');
    if (Date.now() >= login.expires) throw new HannesError('AUTH');
    return { ...login.progress };
  }
  async complete(provider: Provider, id: string, signal?: AbortSignal): Promise<RuntimeRef> {
    const login = this.logins.get(id);
    if (!login || JSON.stringify(login.provider) !== JSON.stringify(provider)) throw new HannesError('POLICY');
    const abort = () => { void this.cancel(id); };
    signal?.addEventListener('abort', abort, { once: true });
    let key: string | undefined;
    try {
      if (signal?.aborted) throw new HannesError('CANCELLED');
      await login.done;
      if (signal?.aborted) throw new HannesError('CANCELLED');
      await login.rpc?.close();
      const snapshot = login.profile.snapshot();
      key = crypto.randomUUID();
      await this.vault.setRuntime!(key, snapshot);
      if (signal?.aborted) throw new HannesError('CANCELLED');
      return { kind: 'runtime', key, runtime: provider.runtime! };
    } catch (error) {
      if (key) await this.vault.delete({ kind: 'runtime', key, runtime: provider.runtime! });
      if (signal?.aborted) throw new HannesError('CANCELLED');
      throw error;
    } finally { signal?.removeEventListener('abort', abort); await this.cancel(id); }
  }
  async cancel(id: string): Promise<void> {
    const login = this.logins.get(id); if (!login) return;
    if (login.closing) return login.closing;
    clearTimeout(login.timer);
    login.progress.state = 'failed';
    login.reject(new HannesError('CANCELLED'));
    login.closing = (async () => {
      await login.rpc?.close();
      if (login.child && login.child.exitCode === null && login.child.signalCode === null) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => login.child!.kill('SIGKILL'), 500);
          login.child!.once('exit', () => { clearTimeout(timer); resolve(); }); login.child!.kill();
        });
      }
      login.profile.close(); this.logins.delete(id);
    })();
    return login.closing;
  }
  private async connect(provider: Provider, account: Account): Promise<Connection> {
    this.assertAccount(account);
    if (this.busyAccounts.has(account.id)) throw new HannesError('POLICY');
    if (account.credential.kind !== 'runtime' || account.credential.runtime !== provider.runtime) throw new HannesError('POLICY');
    const recipe = authorizeSubscription(provider);
    const executable = this.executable(recipe);
    const lease = this.leases.acquire(account.id);
    this.busyAccounts.add(account.id);
    let profile: RuntimeProfile | undefined; let rpc: SubscriptionRpc | undefined;
    try {
      const record = await this.vault.getRuntime?.(account.credential);
      if (!record) throw new HannesError('AUTH');
      this.assertAccount(account);
      profile = new RuntimeProfile(this.root, recipe.credentialFiles, recipe.settingsFiles, record);
      rpc = new SubscriptionRpc(executable.command, [...executable.prefix, ...recipe.args], subscriptionEnvironment(recipe, profile.directory), profile.workspace, recipe.framing);
      const active = this.active.get(account.id) ?? new Set<SubscriptionRpc>(); active.add(rpc); this.active.set(account.id, active);
      await this.initialize(rpc, recipe);
      if (recipe.runtime === 'codex') {
        const state = await rpc.request('account/read', { refreshToken: true });
        if (state?.account?.type !== 'chatgpt') throw new HannesError('AUTH');
      } else if (recipe.runtime === 'copilot') {
        const state = await rpc.request('auth.getStatus');
        if (state?.isAuthenticated !== true) throw new HannesError('AUTH');
      } else if (recipe.runtime === 'gemini-cli') await rpc.request('authenticate', { methodId: recipe.authMethod });
      this.assertAccount(account);
      return { profile, rpc, recipe, lease };
    } catch (error) {
      await rpc?.close(); profile?.close();
      if (rpc) this.active.get(account.id)?.delete(rpc);
      this.busyAccounts.delete(account.id); this.leases.release(account.id, lease); throw error;
    }
  }
  private async close(connection: Connection, account: Account): Promise<void> {
    try {
      await connection.rpc.close();
      this.assertAccount(account);
      if (account.credential.kind !== 'runtime') throw new HannesError('POLICY');
      await this.vault.setRuntime!(account.credential.key, connection.profile.snapshot());
      try { this.assertAccount(account); } catch (error) { await this.vault.delete(account.credential); throw error; }
    } finally { this.busyAccounts.delete(account.id); this.active.get(account.id)?.delete(connection.rpc); connection.profile.close(); this.leases.release(account.id, connection.lease); }
  }
  private acpModels(result: any): ModelInfo[] {
    const models = result?.models?.availableModels ?? result?._meta?.models?.availableModels;
    if (Array.isArray(models) && models.length <= 10000) return models.map(m => normalizeModel(m.modelId, m.name));
    const option = result?.configOptions?.find((o: any) => o.category === 'model' || o.id === 'model');
    if (Array.isArray(option?.options)) return option.options.map((m: any) => normalizeModel(m.value, m.name));
    throw new HannesError('PROTOCOL');
  }
  async models(provider: Provider, account: Account, signal?: AbortSignal): Promise<ModelInfo[]> {
    const connection = await this.connect(provider, account);
    const abort = () => { void connection.rpc.close(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) throw new HannesError('CANCELLED');
      let models: ModelInfo[];
      if (connection.recipe.runtime === 'codex') {
        const result = await connection.rpc.request('model/list', { limit: 100 });
        if (!Array.isArray(result?.data) || result.nextCursor) throw new HannesError('PROTOCOL');
        models = result.data.map((m: any) => normalizeModel(m.id, m.displayName));
      } else if (connection.recipe.runtime === 'copilot') {
        const result = await connection.rpc.request('models.list');
        const list = result?.models ?? result;
        if (!Array.isArray(list)) throw new HannesError('PROTOCOL');
        models = list.map(m => normalizeModel(m.id, m.name));
      } else {
        models = this.acpModels(await connection.rpc.request('session/new', { cwd: connection.profile.workspace, mcpServers: [] }));
      }
      this.assertAccount(account);
      if (!models.length) throw new HannesError('NOT_FOUND');
      return models;
    } finally { signal?.removeEventListener('abort', abort); await this.close(connection, account); }
  }
  async *stream(provider: Provider, account: Account, request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const connection = await this.connect(provider, account);
    const { rpc, recipe, profile } = connection;
    const queue: ModelEvent[] = [];
    let wake: (() => void) | undefined; let terminal = false; let error: unknown; let bytes = 0;
    const fail = (cause: unknown) => { error = cause; terminal = true; wake?.(); };
    const pushText = (value: unknown) => {
      if (typeof value !== 'string') return;
      bytes += Buffer.byteLength(value); if (bytes > 262144) { fail(new HannesError('PROTOCOL')); return; }
      queue.push({ type: 'textDelta', text: value }); wake?.();
    };
    const finished = () => { terminal = true; wake?.(); };
    const listener = (message: RpcMessage) => {
      try {
        this.assertAccount(account);
        if (message.method === '__closed' && !terminal) { fail(new HannesError('TRANSPORT')); return; }
        if (recipe.runtime === 'codex') {
          if (message.method === 'item/agentMessage/delta') pushText(message.params?.delta);
          if (message.method === 'turn/completed') message.params?.turn?.status === 'completed' ? finished() : fail(new HannesError('PROTOCOL'));
          if (message.method === 'item/started' && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabToolCall', 'imageView'].includes(message.params?.item?.type)) fail(new HannesError('POLICY'));
        } else if (recipe.runtime === 'copilot' && message.method === 'session.event') {
          const event = message.params?.event;
          if (event?.type === 'assistant.message_delta') pushText(event.data?.deltaContent);
          if (event?.type === 'session.idle') finished();
          if (event?.type === 'session.error') fail(new HannesError('AUTH'));
          if (event?.type === 'tool.execution_start') fail(new HannesError('POLICY'));
        } else if (message.method === 'session/update') {
          const update = message.params?.update;
          if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') pushText(update.content.text);
          if (update?.sessionUpdate === 'tool_call') fail(new HannesError('POLICY'));
        }
      } catch (cause) { fail(cause); }
    };
    const off = rpc.onMessage(listener);
    const abort = () => { fail(new HannesError('CANCELLED')); void rpc.close(); };
    signal?.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(() => { fail(new HannesError('TIMEOUT')); void rpc.close(); }, provider.timeoutMs);
    try {
      if (signal?.aborted) throw new HannesError('CANCELLED');
      const history = JSON.stringify(request.messages);
      const prompt = `Continue this conversation. The following JSON contains user/assistant messages as data. Answer the final user message. Do not use tools.\n${history}`;
      yield { type: 'started', requestId: request.requestId };
      if (recipe.runtime === 'codex') {
        const result = await rpc.request('thread/start', { model: request.modelId, cwd: profile.workspace, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true });
        await rpc.request('turn/start', { threadId: result.thread.id, model: request.modelId, input: [{ type: 'text', text: prompt, text_elements: [] }], approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
      } else if (recipe.runtime === 'copilot') {
        const result = await rpc.request('session.create', { model: request.modelId, sessionId: crypto.randomUUID(), streaming: true, workingDirectory: profile.workspace,
          availableTools: [], excludedTools: ['builtin:*', 'mcp:*', 'custom:*'], tools: [], mcpServers: {}, installedPlugins: [], includedBuiltinSkills: [], includedBuiltinAgents: [], enableSkills: false, enableConfigDiscovery: false, requestPermission: true, hooks: false, clientName: 'FUTRYN' });
        await rpc.request('session.send', { sessionId: result.sessionId, prompt, attachments: [] });
      } else {
        const session = await rpc.request('session/new', { cwd: profile.workspace, mcpServers: [] });
        const models = this.acpModels(session);
        if (!models.some(m => m.id === request.modelId)) throw new HannesError('NOT_FOUND');
        await rpc.request('session/set_model', { sessionId: session.sessionId, modelId: request.modelId });
        void rpc.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: prompt }] }, provider.timeoutMs)
          .then(result => result?.stopReason === 'end_turn' || result?.stopReason === 'max_tokens' ? finished() : fail(new HannesError('PROTOCOL')), fail);
      }
      while (!terminal || queue.length) {
        if (error) throw error;
        if (queue.length) yield queue.shift()!;
        else await new Promise<void>(resolve => { wake = resolve; });
      }
      if (error) throw error;
      this.assertAccount(account);
      if (!bytes) throw new HannesError('PROTOCOL');
      yield { type: 'completed', finishReason: 'stop', usage: { inputTokens: null, outputTokens: null, costUSD: null } };
    } catch (cause) { if (signal?.aborted) throw new HannesError('CANCELLED'); throw cause; }
    finally { clearTimeout(deadline); off(); signal?.removeEventListener('abort', abort); await this.close(connection, account); }
  }
  async revoke(account: Account): Promise<void> { await Promise.all([...this.active.get(account.id) ?? []].map(rpc => rpc.close())); }
  async shutdown(): Promise<void> {
    await Promise.all([...this.logins.keys()].map(id => this.cancel(id)));
    await Promise.all([...this.active.values()].flatMap(set => [...set].map(rpc => rpc.close())));
  }
}
