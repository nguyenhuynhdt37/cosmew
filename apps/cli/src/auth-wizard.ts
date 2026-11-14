import { HannesError, modelIdSchema, providerSchema, type Account, type Provider } from '@hannes/contracts';
import { terminalText, validateEndpoint } from '@hannes/security';
import type { Application } from './bootstrap/startup';
import type { ChatInput } from './input';

type Print = (text: string) => void;
async function choose(input: ChatInput, print: Print, label: string, choices: { id: string; name: string; aliases?: string[] }[], fallback?: string): Promise<string> {
  let visible = choices;
  while (true) {
    visible.slice(0, 20).forEach((choice, index) => print(`  ${index + 1}. ${choice.name}`));
    if (visible.length > 20) print(`Hiển thị 20/${visible.length}. Nhập từ khóa để lọc hoặc ID đầy đủ.`);
    const answer = await input.ask(label, fallback);
    const choice = choices.find(c => c.id === answer || c.aliases?.includes(answer)) ?? (/^\d+$/.test(answer) ? visible.slice(0, 20)[Number(answer) - 1] : undefined);
    if (choice) return choice.id;
    const filtered = choices.filter(c => (c.id + ' ' + c.name).toLowerCase().includes(answer.toLowerCase()));
    if (!answer || !filtered.length) throw new HannesError('INVALID_INPUT');
    visible = filtered; fallback = undefined;
  }
}

export async function loginWizard(app: Application, input: ChatInput, signal: AbortSignal,
  validate: (account: Account) => Promise<unknown>, project?: string, accountId?: string): Promise<Account> {
  const print: Print = text => process.stdout.write(terminalText(app.redactor.text(text)) + '\n');
  print('Đăng nhập — chọn provider, tài khoản và model. Gõ /cancel ở câu hỏi để hủy.');
  let existing = accountId ? app.accounts.get(accountId) : undefined;
  if (!accountId && app.accounts.list().length) {
    const selected = await choose(input, print, 'Tài khoản', [
      ...app.accounts.list().map(a => ({ id: a.id, aliases: [a.alias], name: `${a.alias} · ${a.providerId} · ${a.status}` })),
      { id: 'new', name: 'Thêm tài khoản mới' },
    ], '1');
    if (selected !== 'new') existing = app.accounts.get(selected);
  }
  let provider: Provider;
  if (existing) provider = app.registry.get(existing.providerId);
  else {
    const available = app.integrations.list().map(i => i.provider);
    const id = await choose(input, print, 'Provider', [...available, { id: '@custom', aliases: ['custom'], name: 'Gateway riêng / 9Router (URL + model)' }], String(available.length + 1));
    if (id === '@custom') {
      const id = await input.ask('Tên cấu hình gateway', 'my-9router');
      if (app.registry.list().some(p => p.id === id)) throw new HannesError('INVALID_INPUT');
      const baseURL = validateEndpoint(await input.ask('Base URL (thường kết thúc bằng /v1)'));
      const protocol = await choose(input, print, 'Protocol', [
        { id: 'responses', name: 'OpenAI Responses' }, { id: 'chat', name: 'OpenAI Chat Completions' },
        { id: 'anthropic', name: 'Anthropic Messages' }, { id: 'gemini', name: 'Google Gemini' },
      ], 'responses');
      const auth = await choose(input, print, 'Xác thực', [{ id: 'api-key', name: 'API key' }, { id: 'none', name: 'Không cần key (local/public)' }], 'api-key');
      const discover = await input.ask('Gateway có API liệt kê models? (y/n)', 'n');
      if (!['y', 'n'].includes(discover.toLowerCase())) throw new HannesError('INVALID_INPUT');
      provider = app.registry.add(providerSchema.parse({ id, name: id, baseURL, protocol, auth,
        catalog: discover.toLowerCase() === 'y' ? protocol === 'anthropic' ? 'anthropic' : protocol === 'gemini' ? 'gemini' : 'openai' : 'manual', metadataVersion: 1 }));
    } else provider = app.registry.list().find(p => p.id === id) ?? app.registry.add(available.find(p => p.id === id)!);
  }
  const alias = existing?.alias ?? await input.ask('Tên tài khoản', provider.id);
  if (!existing) {
    const saved = app.accounts.list().find(a => a.alias === alias);
    if (saved && saved.providerId !== provider.id) throw new HannesError('INVALID_INPUT');
    existing = saved;
  }
  const manualModel = provider.catalog === 'manual' ? modelIdSchema.parse(await input.ask('Model ID', existing?.defaultModel)) : undefined;
  const reuse = existing && existing.status !== 'logged-out' ? await input.ask('Dùng thông tin đăng nhập đã lưu? (y/n)', 'y') : 'n';
  if (!['y', 'n'].includes(reuse.toLowerCase())) throw new HannesError('INVALID_INPUT');
  let account: Account;
  if (reuse.toLowerCase() === 'y') account = existing!;
  else {
    const methods = app.integrations.list().find(i => i.provider.id === provider.id)!.methods;
    const method = provider.auth === 'none' ? 'none' : await choose(input, print, 'Lưu key', methods.map(m => ({
      id: m.id === 'api-key' ? 'keyring' : m.id,
      name: m.id === 'api-key' ? 'Nhập key ẩn và lưu vào OS keyring' : m.id === 'env' ? 'Dùng biến môi trường đã có' : m.name,
    })), 'keyring');
    if (method === 'openrouter-oauth') {
      const client = app.createFutrynClient();
      const challenge = await client.beginProviderAuth(provider.id);
      try {
        print('OpenRouter OAuth: open this URL in your browser, authorize and paste the one-time code:');
        print(challenge.authorizationURL);
        const code = await input.secret();
        account = await client.connectAccount({ providerId: provider.id, alias, credential: { kind: 'keyring', key: crypto.randomUUID() },
          authChallengeId: challenge.id, authorizationCode: code, reauthenticateAccountId: existing?.id, manualModelId: manualModel }, signal);
      } finally { client.cancelProviderAuth(challenge.id); }
    } else {
      const credential = method === 'none' ? { kind: 'none' as const } : method === 'env'
        ? { kind: 'env' as const, name: await input.ask('Tên biến môi trường (không nhập giá trị key)') }
        : { kind: 'keyring' as const, key: crypto.randomUUID() };
      const secret = method === 'keyring' ? await input.secret() : undefined;
      signal.throwIfAborted();
      account = existing ? await app.accounts.reauthenticate(existing.id, credential, secret) : await app.accounts.add(provider.id, alias, credential, secret);
    }
  }
  if (manualModel) app.catalog(account).manual(manualModel);
  // Validation must use the selected manual model rather than an old account default.
  if (manualModel) app.router.select(account, app.catalog(account).cached().find(m => m.id === manualModel)!, project);
  try {
    print('Đang kiểm tra kết nối…'); await validate(app.accounts.get(account.id)); signal.throwIfAborted();
  } catch (error) {
    if (reuse.toLowerCase() !== 'y') await app.accounts.logout(account.id, !existing);
    throw error;
  }
  account = app.accounts.get(account.id);
  const models = app.catalog(account).cached();
  if (!models.length) throw new HannesError('NOT_FOUND');
  const defaultModel = models.find(m => m.id === account.defaultModel)?.id ?? models[0]!.id;
  const selected = manualModel ?? await choose(input, print, 'Model', models.map(m => ({ id: m.id, name: `${m.name} · ${m.id}` })), defaultModel);
  app.router.select(account, models.find(m => m.id === selected)!, project);
  print(`Đã đăng nhập ${account.alias} · ${provider.name} · ${selected}. Bạn có thể chat ngay.`);
  return account;
}
