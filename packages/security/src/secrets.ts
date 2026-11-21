import {FutrynError, credentialRefSchema, type CredentialRef, type CredentialVault} from '@cosmew/contracts';

export class Redactor {
  private readonly secrets = new Set<string>();
  register(secret: string) {
    if (secret) this.secrets.add(secret);
  }
  text(value: string): string {
    let result = value;
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length))
      result = result.split(secret).join('[REDACTED]');
    return result.replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]').replace(/\bsk-[\w-]+/g, '[REDACTED]');
  }
  stream() {
    let pending = '';
    return {
      push: (chunk: string) => {
        let safe = pending + chunk;
        for (const secret of [...this.secrets].sort((a, b) => b.length - a.length))
          safe = safe.split(secret).join('[REDACTED]');
        let reserve = 0;
        for (const secret of this.secrets) {
          for (let length = Math.min(secret.length - 1, safe.length); length > reserve; length--) {
            if (safe.endsWith(secret.slice(0, length))) {
              reserve = length;
              break;
            }
          }
        }
        pending = reserve ? safe.slice(-reserve) : '';
        return this.text(reserve ? safe.slice(0, -reserve) : safe);
      },
      finish: () => {
        const result = this.text(pending);
        pending = '';
        return result;
      },
    };
  }
}

export class SecureVault implements CredentialVault {
  constructor(
    private readonly redactor = new Redactor(),
    private readonly environment: Record<string, string | undefined> = process.env,
  ) {}
  private async entry(key: string) {
    const {AsyncEntry} = await import('@napi-rs/keyring');
    // Keep the legacy keyring service identity so existing credentials remain accessible.
    // Require persistent Secret Service on Linux, never silently switch backend.
    return new AsyncEntry('hannes.provider-auth.v1', key, {linux: {store: 'secret-service'}});
  }
  async get(reference: CredentialRef): Promise<string | undefined> {
    try {
      const ref = credentialRefSchema.parse(reference);
      const secret =
        ref.kind === 'none'
          ? undefined
          : ref.kind === 'env'
            ? this.environment[ref.name]
            : ((await (await this.entry(ref.key)).getPassword()) ?? undefined);
      if (secret && (secret.length > 8192 || /[\x00-\x20\x7f]/.test(secret))) throw new FutrynError('AUTH');
      if (secret) this.redactor.register(secret);
      return secret;
    } catch (e) {
      if (e instanceof FutrynError) throw e;
      throw new FutrynError('STORAGE');
    }
  }
  async set(key: string, secret: string): Promise<void> {
    if (!secret || secret.length > 8192 || /[\x00-\x20\x7f]/.test(secret)) throw new FutrynError('INVALID_INPUT');
    this.redactor.register(secret);
    try {
      credentialRefSchema.parse({kind: 'keyring', key});
      await (await this.entry(key)).setPassword(secret);
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  async delete(ref: CredentialRef): Promise<void> {
    try {
      if (ref.kind === 'keyring') await (await this.entry(ref.key)).deleteCredential();
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
}

export function terminalText(value: string): string {
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/** Redact normalized model text before it reaches durable transcripts or UI sinks. */
export function redactModel(
  model: import('@cosmew/contracts').ModelPort,
  redactor: Redactor,
): import('@cosmew/contracts').ModelPort {
  return {
    async *stream(request, signal) {
      const filter = redactor.stream();
      const reasoning = redactor.stream();
      for await (const event of model.stream(request, signal)) {
        if (event.type === 'textDelta') {
          const text = filter.push(event.text);
          if (text) yield {type: 'textDelta', text: terminalText(text)};
        } else if (event.type === 'reasoningDelta') {
          const text = reasoning.push(event.text);
          if (text) yield {type: 'reasoningDelta', text: terminalText(text)};
        } else if (event.type === 'completed') {
          const summary = reasoning.finish();
          if (summary) yield {type: 'reasoningDelta', text: terminalText(summary)};
          const text = filter.finish();
          if (text) yield {type: 'textDelta', text: terminalText(text)};
          yield event;
        } else yield event;
      }
    },
    async generate(request, signal) {
      const result = await model.generate(request, signal);
      return {...result, text: redactor.text(result.text)};
    },
  };
}
