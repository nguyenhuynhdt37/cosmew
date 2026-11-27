import {FutrynError, providerSchema, type Provider, type SettingsStore} from '@cosmew/contracts';

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
    // ADR 0048: reasoning_content is replayed, chunks may stay silent for minutes (DeepSeek asks for 15).
    streamUsage: true,
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'chat',
    baseURL: 'https://api.deepseek.com',
    auth: 'api-key',
    catalog: 'openai',
    metadataVersion: 1,
    timeoutMs: 60000,
    streamIdleTimeoutMs: 900000,
    replayReasoning: true,
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
    // ADR 0047: "Sign in with ChatGPT" token sharing; Cosmew runs the agent loop (backend `hannes`).
    // Discover the selected account's model slugs from the ChatGPT /models response.
    id: 'chatgpt-api',
    name: 'ChatGPT subscription · API',
    protocol: 'responses',
    baseURL: 'https://api.openai.com/v1',
    auth: 'oauth',
    catalog: 'openai',
    metadataVersion: 1,
    timeoutMs: 60000,
    family: 'openai',
    requestEncoding: 'zstd',
  },
];
/** Built-in sign-in providers whose ids a host config may not redefine. */
export const reservedProviderIds: ReadonlySet<string> = new Set(
  providerPresets.filter(p => p.auth === 'oauth').map(p => p.id),
);
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
  methods(provider: Provider): import('@cosmew/contracts').AuthMethod[] {
    if (provider.auth === 'oauth')
      return [
        {
          id: 'oauth-browser',
          name: 'Sign in with ChatGPT',
          description: 'Browser sign-in; Cosmew runs the agent and tools. Tokens stay in the OS keyring.',
          autoComplete: true,
        },
      ];
    const methods: import('@cosmew/contracts').AuthMethod[] =
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
          : provider.auth === 'aws-sigv4'
            ? [
                {
                  id: 'none',
                  name: 'AWS Credentials (IAM / SigV4)',
                  description:
                    'Signs Bedrock requests with AWS SigV4 using AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY or ~/.aws/credentials.',
                },
              ]
            : provider.auth === 'google-adc'
              ? [
                  {
                    id: 'none',
                    name: 'Google Cloud ADC / Service Account',
                    description:
                      'Exchanges GOOGLE_APPLICATION_CREDENTIALS, configured credential_file, or gcloud ADC for OAuth2 Bearer tokens.',
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
  get(id: string): import('@cosmew/contracts').Integration {
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
  list(): import('@cosmew/contracts').Integration[] {
    const groups = new Map<string, import('@cosmew/contracts').Integration>();
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
