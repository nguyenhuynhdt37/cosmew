/** Deterministic CI wire fixture, never a production export or vendor evidence. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
const runtime = process.argv[2]!;
const scenario = process.argv[3]!;
const copilot = runtime === 'copilot';
const profile = process.env.CODEX_HOME ?? process.env.COPILOT_HOME ?? process.env.QWEN_HOME ?? process.env.GEMINI_CLI_HOME!;
if (!profile || !process.cwd().startsWith(profile)) process.exit(11);
if (process.env.OPENAI_API_KEY || process.env.GITHUB_TOKEN || process.env.NODE_OPTIONS || process.env.COPILOT_ALLOW_ALL !== 'false') process.exit(12);
const credential = runtime === 'codex' ? 'auth.json' : copilot ? 'config.json' : runtime === 'gemini-cli' ? '.gemini/oauth_creds.json' : 'oauth_creds.json';
const save = () => {
  if (scenario === 'missing-creds') return;
  const path = join(profile, credential); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Copilot 1.0.107 prefixes its managed credential document with comments.
  const header = copilot ? '// User settings belong in settings.json.\n// This file is managed automatically.\n' : '';
  writeFileSync(path, header + JSON.stringify({ access_token: 'fixture-runtime-secret-' + crypto.randomUUID(), refresh_token: 'fixture-refresh' }), { mode: 0o600 });
};
const valid = () => { if (copilot && process.argv.includes('--no-auto-login')) return false; try { return !!JSON.parse(readFileSync(join(profile, credential), 'utf8').replace(/^(?:\/\/[^\n]*\n)*/, '')).access_token; } catch { return false; } };
if (copilot && process.argv.includes('login')) {
  process.stdout.write('https://github.com/login/device\nDevice code: ABCD-1234\n');
  setTimeout(() => { save(); process.exit(scenario === 'reject' ? 1 : 0); }, scenario === 'slow-auth' ? 20000 : 30);
} else {
  let input = Buffer.alloc(0); let session = 'fixture-session'; let permissionReply = false;
  function send(value: unknown) {
    const body = JSON.stringify(value);
    const text = copilot ? `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}` : body + '\n';
    process.stdout.write(text.slice(0, 9)); process.stdout.write(text.slice(9));
  }
  const event = (method: string, params: unknown) => send({ jsonrpc: '2.0', method, params });
  const notifyCopilot = (type: string, data = {}) => event('session.event', { sessionId: session, event: { type, data } });
  async function handle(message: any) {
    if (message.id === 'denied-tool') {
      permissionReply = message.error?.code === -32601 || message.result?.decision === 'decline' || message.result?.kind === 'denied-by-rules' || message.result?.outcome?.outcome === 'cancelled';
      if (!permissionReply) process.exit(23);
      return;
    }
    if (!message.method || message.id === undefined) return;
    const p = message.params ?? {};
    let result: any = {};
    switch (message.method) {
      case 'initialize': result = runtime === 'codex' ? { userAgent: 'fixture-runtime/1' } : { protocolVersion: 1, authMethods: [{ id: runtime === 'gemini-cli' ? 'oauth-personal' : 'qwen-oauth' }] }; break;
      case 'ping': result = { protocolVersion: 3, message: p.message }; break;
      case 'account/login/start':
        result = { type: p.type, loginId: 'fixture-login', authUrl: 'https://auth.openai.com/fixture', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' };
        setTimeout(() => { save(); event('account/login/completed', { loginId: 'fixture-login', success: scenario !== 'reject' }); }, scenario === 'slow-auth' ? 20000 : 30); break;
      case 'authenticate':
        if (valid()) break;
        event('_authenticate/update', { _meta: { authUri: runtime === 'gemini-cli' ? 'https://accounts.google.com/fixture' : 'https://chat.qwen.ai/authorize?user_code=ABCD-1234' } });
        await Bun.sleep(scenario === 'slow-auth' ? 20000 : 30);
        if (scenario === 'reject') { send({ id: message.id, error: { code: -32000, message: 'RAW fixture-runtime-secret forbidden' } }); return; }
        save(); break;
      case 'account/read': result = { account: valid() ? { type: 'chatgpt', planType: 'plus' } : null }; break;
      case 'auth.getStatus': result = { isAuthenticated: valid() }; break;
      case 'model/list': result = { data: [{ id: 'runtime-model', displayName: 'Runtime model' }, { id: 'runtime-alt', displayName: 'Alternate' }], nextCursor: null }; break;
      case 'models.list': result = { models: [{ id: 'runtime-model', name: 'Runtime model' }, { id: 'runtime-alt', name: 'Alternate' }] }; break;
      case 'session/new': {
        const settingsFile = runtime === 'gemini-cli' ? '.gemini/settings.json' : 'settings.json';
        const config = JSON.parse(readFileSync(join(profile, settingsFile), 'utf8'));
        if (runtime === 'gemini-cli' ? config.tools.core.length !== 0 : config.permissions.deny[0] !== '*') process.exit(24);
        result = { sessionId: session, models: { availableModels: [{ modelId: 'runtime-model', name: 'Runtime model' }, { modelId: 'runtime-alt', name: 'Alternate' }] } }; break;
      }
      case 'thread/start':
        if (p.approvalPolicy !== 'never' || p.sandbox !== 'read-only' || !p.ephemeral) process.exit(25);
        if (!readFileSync(join(profile, 'config.toml'), 'utf8').includes('shell_tool = false')) process.exit(26);
        result = { thread: { id: session } }; break;
      case 'session.create':
        if (p.availableTools.length || !p.requestPermission || p.enableConfigDiscovery !== false || p.installedPlugins.length) process.exit(27);
        result = { sessionId: session }; break;
      case 'turn/start': case 'session.send': case 'session/prompt': {
        if (!valid()) { send({ id: message.id, error: { code: -32000, message: 'Expired secret' } }); return; }
        if (scenario === 'tool-attempt') {
          send({ id: 'denied-tool', method: copilot ? 'permission.request' : runtime === 'codex' ? 'item/commandExecution/requestApproval' : 'session/request_permission', params: {} });
          await Bun.sleep(20);
          if (!permissionReply) process.exit(28);
          if (copilot) notifyCopilot('tool.execution_start');
          else if (runtime === 'codex') event('item/started', { item: { type: 'commandExecution' } });
          else event('session/update', { update: { sessionUpdate: 'tool_call' } });
          result = { stopReason: 'end_turn' }; break;
        }
        const text = 'Subscription fixture response';
        if (copilot) notifyCopilot('assistant.message_delta', { deltaContent: text });
        else if (runtime === 'codex') event('item/agentMessage/delta', { delta: text });
        else event('session/update', { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
        if (scenario === 'long-stream') await Bun.sleep(20000);
        if (scenario === 'no-terminal') { process.exit(0); }
        if (copilot) notifyCopilot('session.idle');
        else if (runtime === 'codex') event('turn/completed', { turn: { status: 'completed' } });
        result = { stopReason: 'end_turn', messageId: 'fixture-message' }; break;
      }
      case 'session/set_model': break;
      default: send({ id: message.id, error: { code: -32601, message: 'Unknown fixture method' } }); return;
    }
    send({ jsonrpc: '2.0', id: message.id, result });
  }
  process.stdin.on('data', (chunk: Buffer) => {
    input = Buffer.concat([input, chunk]);
    while (input.length) {
      let bytes: Buffer;
      if (copilot) {
        const boundary = input.indexOf('\r\n\r\n'); if (boundary < 0) return;
        const length = Number(/Content-Length: (\d+)/i.exec(input.subarray(0, boundary).toString())![1]);
        if (input.length < boundary + 4 + length) return;
        bytes = input.subarray(boundary + 4, boundary + 4 + length); input = input.subarray(boundary + 4 + length);
      } else {
        const end = input.indexOf(10); if (end < 0) return;
        bytes = input.subarray(0, end); input = input.subarray(end + 1);
      }
      void handle(JSON.parse(bytes.toString()));
    }
  });
}
