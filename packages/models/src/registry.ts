import { HannesError, providerSchema, type Provider, type SettingsStore } from '@hannes/contracts';

export const providerPresets: readonly Provider[] = [
  { id: 'openai', name: 'OpenAI API', protocol: 'responses', baseURL: 'https://api.openai.com/v1', auth: 'api-key', catalog: 'openai', metadataVersion: 1, timeoutMs: 60000 },
  { id: 'anthropic', name: 'Anthropic API', protocol: 'anthropic', baseURL: 'https://api.anthropic.com/v1', auth: 'api-key', catalog: 'anthropic', metadataVersion: 1, timeoutMs: 60000 },
  { id: 'gemini', name: 'Google Gemini API', protocol: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta', auth: 'api-key', catalog: 'gemini', metadataVersion: 1, timeoutMs: 60000 },
  { streamUsage: true, id: 'openrouter', name: 'OpenRouter', protocol: 'chat', baseURL: 'https://openrouter.ai/api/v1', auth: 'api-key', catalog: 'openai', metadataVersion: 1, timeoutMs: 60000 },
  { streamUsage: true, id: 'ollama', name: 'Ollama local', protocol: 'chat', baseURL: 'http://127.0.0.1:11434/v1', auth: 'none', catalog: 'ollama', metadataVersion: 1, timeoutMs: 120000 },
];
export class ProviderRegistry {
  constructor(private readonly store: SettingsStore) {}
  list(): Provider[] { return this.store.read().providers; }
  get(id: string): Provider {
    const p = this.list().find(p => p.id === id); if (!p) throw new HannesError('NOT_FOUND'); return p;
  }
  add(input: unknown): Provider {
    let p: Provider; try { p = providerSchema.parse(input); } catch { throw new HannesError('INVALID_INPUT'); }
    this.store.update(s => { if (s.providers.some(x => x.id === p.id)) throw new HannesError('INVALID_INPUT'); s.providers.push(p); }); return p;
  }
  remove(id: string): void {
    this.get(id); this.store.update(s => {
      if (s.accounts.some(a => a.providerId === id)) throw new HannesError('POLICY');
      s.providers = s.providers.filter(p => p.id !== id);
    });
  }
}


/** Composition-owned method registration. Future plugin hosts may receive only a
 * provider-scoped registrar, never SettingsStore or CredentialVault. No plugin
 * loading or delegated authentication is enabled by this metadata registry. */
export class AuthMethodRegistry {
  methods(provider: Provider): import('@hannes/contracts').AuthMethod[] {
    const methods: import('@hannes/contracts').AuthMethod[] = provider.auth === 'none'
      ? [{ id: 'none', name: 'No authentication', description: 'For explicitly configured local or public endpoints.' }]
      : [
          { id: 'api-key', name: 'API key', description: 'Store securely in the operating system keyring.' },
          { id: 'env', name: 'Environment variable', description: 'Store only a variable name; resolve it at runtime.' },
        ];
    if (provider.id === 'openrouter' && provider.baseURL === 'https://openrouter.ai/api/v1' && provider.protocol === 'chat' && provider.auth === 'api-key') {
      methods.push({ id: 'openrouter-oauth', name: 'OpenRouter OAuth (PKCE)', description: 'Authorize in your browser, then paste the one-time code. Uses your OpenRouter API credits.' });
    }
    return methods;
  }
}

export class IntegrationRegistry {
  constructor(private readonly providers: ProviderRegistry, private readonly auth = new AuthMethodRegistry()) {}
  list(): import('@hannes/contracts').Integration[] {
    const merged = new Map(providerPresets.map(p => [p.id, p]));
    for (const p of this.providers.list()) merged.set(p.id, p);
    return [...merged.values()].map(provider => ({
      provider, methods: this.auth.methods(provider),
      notice: 'Use provider API credentials. Consumer subscriptions do not automatically grant third-party API access. Only registered official methods are offered. Device code and delegated CLI drivers are not implemented.',
    }));
  }
}

export { ModelRouter as ModelSelector } from './router';
