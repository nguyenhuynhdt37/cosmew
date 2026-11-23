import {
  FutrynError,
  modelIdSchema,
  providerSchema,
  isCodingModel,
  type Account,
  type ModelInfo,
  type Provider,
} from '@cosmew/contracts';
import {formatTokenCount} from '@cosmew/models';
import {terminalText, validateEndpoint} from '@cosmew/security';
import {loginOAuth} from './subscriptions/login';
import type {Application} from './bootstrap/startup';
import type {QuickConnectProviderInput} from '@cosmew/sdk';
import type {ChatInput} from './input';

type Print = (text: string) => void;
async function choose(
  input: ChatInput,
  print: Print,
  label: string,
  choices: {id: string; name: string; aliases?: string[]}[],
  fallback?: string,
): Promise<string> {
  let visible = choices;
  while (true) {
    visible.slice(0, 20).forEach((choice, index) => print(`  ${index + 1}. ${choice.name}`));
    if (visible.length > 20) print(`Hiển thị 20/${visible.length}. Nhập từ khóa để lọc hoặc ID đầy đủ.`);
    const answer = await input.ask(label, fallback);
    const choice =
      choices.find(c => c.id === answer || c.aliases?.includes(answer)) ??
      (/^\d+$/.test(answer) ? visible.slice(0, 20)[Number(answer) - 1] : undefined);
    if (choice) return choice.id;
    const filtered = choices.filter(c => (c.id + ' ' + c.name).toLowerCase().includes(answer.toLowerCase()));
    if (!answer || !filtered.length) throw new FutrynError('INVALID_INPUT');
    visible = filtered;
    fallback = undefined;
  }
}

export async function chooseGatewayModel(
  input: ChatInput,
  print: Print,
  catalog: readonly ModelInfo[],
): Promise<string> {
  const models = catalog.filter(model => isCodingModel(model));
  const manual = '!manual';
  if (models.length) {
    const selected = await choose(
      input,
      print,
      'Chọn model',
      [
        ...models.map(model => {
          const context = model.contextLimit ? `${formatTokenCount(model.contextLimit)} ctx` : 'chưa rõ context';
          const output = model.outputLimit ? ` · ${formatTokenCount(model.outputLimit)} out` : '';
          return {id: model.id, name: `${model.id} · ${context}${output}`};
        }),
        {id: manual, aliases: ['manual'], name: 'Nhập Model ID (manual)'},
      ],
      models[0]!.id,
    );
    if (selected !== manual) return selected;
  }
  const model = modelIdSchema.safeParse(await input.ask('Model ID từ gateway'));
  if (!model.success) throw new FutrynError('INVALID_INPUT');
  return model.data;
}

export async function loginWizard(
  app: Application,
  input: ChatInput,
  signal: AbortSignal,
  validate: (account: Account) => Promise<unknown>,
  project?: string,
  accountId?: string,
): Promise<Account> {
  const print: Print = text => process.stdout.write(terminalText(app.redactor.text(text)) + '\n');
  print('Đăng nhập — chọn hãng rồi chọn cách đăng nhập. /cancel để hủy.');
  const existing = accountId ? app.accounts.get(accountId) : undefined;
  let provider: Provider;
  if (existing) provider = app.registry.get(existing.providerId);
  else {
    const available = app.integrations.list().map(i => i.provider);
    const id = await choose(
      input,
      print,
      'Provider',
      [...available, {id: '@custom', aliases: ['custom'], name: 'Gateway riêng / 9Router (URL + model)'}],
      '1',
    );
    if (id === '@custom') {
      const first = await input.ask('Base URL (vd: https://gateway.example/v1; nhập ID để cấu hình nâng cao)');
      if (/^https?:\/\//i.test(first)) {
        const client = app.createFutrynClient(project);
        const options: QuickConnectProviderInput = {
          project,
          chooseModel: models => chooseGatewayModel(input, print, models),
        };
        if (first.includes('|')) options.raw = first;
        else {
          options.baseURL = validateEndpoint(first);
          options.apiKey = process.stdin.isTTY
            ? await input.secret({allowEmpty: true, label: 'API key (ẩn; Enter nếu không cần)'})
            : await input.ask('API key (Enter nếu không cần)', '');
        }
        const result = await client.quickConnectProvider(options, signal);
        print(result.summary);
        return result.account;
      }
      // Advanced custom provider setup when a configuration ID is provided instead of a URL.
      const customId = first;
      if (app.registry.list().some(p => p.id === customId)) throw new FutrynError('INVALID_INPUT');
      const baseURL = validateEndpoint(await input.ask('Base URL (thường kết thúc bằng /v1)'));
      const protocol = await choose(
        input,
        print,
        'Protocol',
        [
          {id: 'responses', name: 'OpenAI Responses'},
          {id: 'chat', name: 'OpenAI Chat Completions'},
          {id: 'anthropic', name: 'Anthropic Messages'},
          {id: 'gemini', name: 'Google Gemini'},
        ],
        'responses',
      );
      const auth = await choose(
        input,
        print,
        'Xác thực',
        [
          {id: 'api-key', name: 'API key'},
          {id: 'none', name: 'Không cần key (local/public)'},
        ],
        'api-key',
      );
      const discover = await input.ask('Gateway có API liệt kê models? (y/n)', 'n');
      if (!['y', 'n'].includes(discover.toLowerCase())) throw new FutrynError('INVALID_INPUT');
      provider = app.registry.add(
        providerSchema.parse({
          id: customId,
          name: customId,
          baseURL,
          protocol,
          auth,
          catalog:
            discover.toLowerCase() === 'y'
              ? protocol === 'anthropic'
                ? 'anthropic'
                : protocol === 'gemini'
                  ? 'gemini'
                  : 'openai'
              : 'manual',
          metadataVersion: 1,
        }),
      );
    } else provider = app.registry.list().find(p => p.id === id) ?? app.registry.add(available.find(p => p.id === id)!);
  }
  let alias = existing?.alias ?? provider.id.slice(0, 90);
  let suffix = 2;
  while (!existing && app.accounts.list().some(account => account.alias === alias))
    alias = `${provider.id.slice(0, 90)}-${suffix++}`;
  let account: Account;
  let manualModel: string | undefined;
  const reuse = !!existing && existing.status !== 'logged-out';
  if (reuse) account = existing;
  else {
    const integration = app.integrations.list().find(i => (i.providerIds ?? [i.provider.id]).includes(provider.id));
    // User-configured gateways are not integration catalog entries. They still have the ordinary
    // API-key/none choices and must not crash the wizard while looking up vendor methods.
    const methods: {id: string; name: string; providerId?: string}[] =
      integration?.methods ??
      (provider.auth === 'api-key'
        ? [{id: 'api-key', name: 'API key'}]
        : [{id: 'none', name: 'Không cần key (local/public)'}]);
    const method =
      provider.auth !== 'api-key'
        ? 'none'
        : await choose(
            input,
            print,
            'Cách đăng nhập',
            methods.map(m => ({
              id: m.id === 'api-key' ? 'keyring' : m.id,
              name: m.name,
            })),
            methods[0]?.id === 'api-key' ? 'keyring' : methods[0]?.id,
          );
    const selected = methods.find(m => m.id === (method === 'keyring' ? 'api-key' : method));
    if (selected?.providerId && selected.providerId !== provider.id) {
      provider =
        app.registry.list().find(p => p.id === selected.providerId) ??
        app.registry.add(app.integrations.get(selected.providerId).provider);
      alias = existing?.alias ?? provider.id.slice(0, 90);
      suffix = 2;
      while (!existing && app.accounts.list().some(a => a.alias === alias))
        alias = `${provider.id.slice(0, 90)}-${suffix++}`;
    }
    manualModel =
      provider.catalog === 'manual' && provider.auth !== 'oauth'
        ? modelIdSchema.parse(await input.ask('Model ID', existing?.defaultModel))
        : undefined;
    if (provider.auth === 'oauth') account = await loginOAuth(app, provider, alias, signal, existing);
    else {
      const client = app.createFutrynClient();
      if (method === 'openrouter-oauth') {
        const challenge = await client.beginProviderAuth(provider.id);
        try {
          print('Mở URL và dán mã xác nhận:');
          print(challenge.authorizationURL);
          const code = await input.secret();
          account = await client.connectAccount(
            {
              providerId: provider.id,
              alias,
              credential: {kind: 'keyring', key: crypto.randomUUID()},
              authChallengeId: challenge.id,
              authorizationCode: code,
              reauthenticateAccountId: existing?.id,
              manualModelId: manualModel,
            },
            signal,
          );
        } finally {
          await client.cancelProviderAuth(challenge.id);
        }
      } else {
        const credential =
          method === 'none'
            ? {kind: 'none' as const}
            : method === 'env'
              ? {kind: 'env' as const, name: await input.ask('Tên biến môi trường (không nhập giá trị key)')}
              : {kind: 'keyring' as const, key: crypto.randomUUID()};
        const secret = method === 'keyring' ? await input.secret() : undefined;
        signal.throwIfAborted();
        account = await client.connectAccount(
          {
            providerId: provider.id,
            alias,
            credential,
            secret,
            manualModelId: manualModel,
            reauthenticateAccountId: existing?.id,
          },
          signal,
        );
      }
    }
  }
  // Everything after connectAccount can still fail (for example, an empty catalog or a
  // selection write). A newly created account must not be left behind when that happens.
  // Reauthentication keeps the fenced identity so the user can retry it explicitly.
  try {
    if (manualModel) app.catalog(account).manual(manualModel);
    // Validation must use the selected manual model rather than an old account default.
    if (manualModel)
      app.router.select(
        account,
        app
          .catalog(account)
          .cached()
          .find(m => m.id === manualModel)!,
        project,
      );
    if (reuse) {
      print('Đang kiểm tra kết nối…');
      await validate(app.accounts.get(account.id));
    }
    signal.throwIfAborted();
    account = app.accounts.get(account.id);
    const models = app.catalog(account).cached();
    if (!models.length) throw new FutrynError('NOT_FOUND');
    const defaultModel = models.find(m => m.id === account.defaultModel)?.id ?? models[0]!.id;
    const selected =
      manualModel ??
      (await choose(
        input,
        print,
        'Model',
        models.map(m => ({id: m.id, name: `${m.name} · ${m.id}`})),
        defaultModel,
      ));
    app.router.select(
      account,
      models.find(m => m.id === selected)!,
      project,
    );
    print(`Đã đăng nhập ${account.alias} · ${provider.name} · ${selected}. Bạn có thể chat ngay.`);
    return account;
  } catch (error) {
    if (!reuse) await app.accounts.logout(account.id, !existing);
    throw error;
  }
}
