import {FutrynError, providerSchema, type Provider, type SettingsStore} from '@futryn/contracts';

export const providerPresets: readonly Provider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'responses',
    baseURL: 'https://api.openai.com/v1',
    auth: 'api-key',
    catalog: 'openai',
    metadataVersion: 1,
    timeoutMs: 60000,
  },
  {
    id: 'anthropic',
    name: 'Claude',
    protocol: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    auth: 'api-key',
    catalog: 'anthropic',
    metadataVersion: 1,
    timeoutMs: 60000,
  },
  {
    id: 'gemini',
    name: 'Google',
    protocol: 'gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    auth: 'api-key',
    catalog: 'gemini',
    metadataVersion: 1,
    timeoutMs: 60000,
  },
  {
    streamUsage: true,
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'chat',
    baseURL: 'https://openrouter.ai/api/v1',
    auth: 'api-key',
    catalog: 'openai',
    metadataVersion: 1,
    timeoutMs: 60000,
  },
  {
    streamUsage: true,
    id: 'xai',
    name: 'xAI Grok',
    protocol: 'chat',
    baseURL: 'https://api.x.ai/v1',
    auth: 'api-key',
    catalog: 'openai',
    metadataVersion: 1,
    timeoutMs: 60000,
    family: 'xai',
  },
  {
    streamUsage: true,
    id: 'ollama',
    name: 'Ollama local',
    protocol: 'chat',
    baseURL: 'http://127.0.0.1:11434/v1',
    auth: 'none',
    catalog: 'ollama',
    metadataVersion: 1,
    timeoutMs: 120000,
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT subscription · Codex',
    protocol: 'responses',
    baseURL: 'https://chatgpt.com',
    auth: 'api-key',
    catalog: 'manual',
    metadataVersion: 1,
    timeoutMs: 300000,
    runtime: 'codex',
    family: 'openai',
  },
];
export class ProviderRegistry {
  constructor(private readonly store: SettingsStore) {}
  list(): Provider[] {
    return this.store.read().providers;
  }
  get(id: string): Provider {
    const p = this.list().find(p => p.id === id);
    if (!p) throw new FutrynError('NOT_FOUND');
    return p;
  }
  add(input: unknown): Provider {
    let p: Provider;
    try {
      p = providerSchema.parse(input);
    } catch {
      throw new FutrynError('INVALID_INPUT');
    }
    this.store.update(s => {
      if (s.providers.some(x => x.id === p.id)) throw new FutrynError('INVALID_INPUT');
      s.providers.push(p);
    });
    return p;
  }
  remove(id: string): void {
    this.get(id);
    this.store.update(s => {
      if (s.accounts.some(a => a.providerId === id)) throw new FutrynError('POLICY');
      s.providers = s.providers.filter(p => p.id !== id);
    });
  }
}

/** Composition-owned method registration. Future plugin hosts may receive only a
 * provider-scoped registrar, never SettingsStore or CredentialVault. No plugin
 * loading or delegated authentication is enabled by this metadata registry. */
export class AuthMethodRegistry {
  methods(provider: Provider): import('@futryn/contracts').AuthMethod[] {
    if (provider.runtime)
      return [
        {
          id: 'subscription-browser',
          name: 'Sign in with ChatGPT',
          description: 'Official runtime browser/device sign-in. Credentials isolated per FUTRYN account.',
          autoComplete: true,
        },
        {
          id: 'subscription-device' as const,
          name: 'Sign in with device code',
          description: 'Official Codex device-code flow.',
          autoComplete: true,
          advanced: true,
        },
      ];
    const methods: import('@futryn/contracts').AuthMethod[] =
      provider.auth === 'none'
        ? [{id: 'none', name: 'No authentication', description: 'For explicitly configured local or public endpoints.'}]
        : provider.auth === 'command'
          ? [
              {
                id: 'none',
                name: 'Token command',
                description: 'The bearer token comes from the command set in your host config; nothing is stored.',
              },
            ]
          : [
              {id: 'api-key', name: 'API key', description: 'Store securely in the operating system keyring.'},
              {
                id: 'env',
                name: 'Environment variable',
                description: 'Use an existing environment variable.',
                advanced: true,
              },
            ];
    if (
      provider.id === 'openrouter' &&
      provider.baseURL === 'https://openrouter.ai/api/v1' &&
      provider.protocol === 'chat' &&
      provider.auth === 'api-key'
    ) {
      methods.push({
        id: 'openrouter-oauth',
        name: 'OpenRouter OAuth (PKCE)',
        description: 'Authorize in your browser, then paste the one-time code. Uses your OpenRouter API credits.',
      });
    }
    return methods;
  }
}

export class IntegrationRegistry {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly auth = new AuthMethodRegistry(),
  ) {}
  private sources(): Provider[] {
    const merged = new Map(providerPresets.map(p => [p.id, p]));
    for (const p of this.providers.list()) merged.set(p.id, p);
    return [...merged.values()];
  }
  get(id: string): import('@futryn/contracts').Integration {
    const provider = this.sources().find(p => p.id === id);
    if (!provider) throw new FutrynError('NOT_FOUND');
    return {
      provider,
      providerIds: [provider.id],
      methods: this.auth.methods(provider).map(method => ({...method, providerId: provider.id})),
      notice:
        provider.id === 'anthropic' ? 'Claude subscription sign-in requires Anthropic approval. Use API key.' : '',
    };
  }
  list(): import('@futryn/contracts').Integration[] {
    const groups = new Map<string, import('@futryn/contracts').Integration>();
    for (const provider of this.sources()) {
      const source = this.get(provider.id);
      const groupId = provider.family ?? provider.id;
      const group = groups.get(groupId);
      if (group) {
        group.providerIds!.push(provider.id);
        group.methods.push(...source.methods);
      } else groups.set(groupId, {...source, providerIds: [provider.id]});
    }
    return [...groups.values()].map(group => ({
      ...group,
      methods: group.methods.toSorted(
        (a, b) => Number(!a.autoComplete) - Number(!b.autoComplete) || Number(!!a.advanced) - Number(!!b.advanced),
      ),
    }));
  }
}

export {ModelRouter as ModelSelector} from './router';
