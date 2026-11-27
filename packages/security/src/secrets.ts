import {FutrynError, credentialRefSchema, type CredentialRef, type CredentialVault} from '@cosmew/contracts';

const AUTH_SCHEME_VALUE = /^(?:Bearer|Basic|Digest|Token|ApiKey)\s+(.+)$/i;
const URL_USER_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:([^/\s@]+)@/i;
const SENSITIVE_KEY_WORD =
  /^(?:key|keys|secret|secrets|token|tokens|password|passwords|passwd|pwd|auth|authorization|proxy-authorization|credential|credentials|cookie|cookies|set-cookie|private|bearer|pat|jwt|session|sessions|dsn|signature|signatures|cert|certs)$/i;
const COMPOUND_SENSITIVE_KEY =
  /(?:apikey|pgpassword|authtoken|secretkey|accesstoken|refreshtoken|clientsecret|privatekey|bearertoken|passphrase|sessiontoken|signingkey|encryptionkey)/i;
const NON_SECRET_KEY_SUFFIX =
  /(?:^|[_.-])(?:mode|type|kind|policy|timeout|ttl|port|host|hostname|level|format|enabled|disabled|count|limit|size|interval|retries|version|alg|algorithm|method|scheme|provider|driver|region|zone|env|name)$/i;
const SECRET_VALUE_PATTERN =
  /^(?:sk-|rk-|pk-|gh[pousr]_|github_pat_|glpat-|xox[abprs]-|npm_|pypi-|AIza[0-9A-Za-z_-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|ak_|pat_)/;

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isSensitiveConfigKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  if (/^(?:authorization|proxy-authorization|cookie|set-cookie)$/.test(normalized)) return true;
  if (NON_SECRET_KEY_SUFFIX.test(normalized)) return false;
  if (COMPOUND_SENSITIVE_KEY.test(normalized.replace(/[-_.\s/:]+/g, ''))) return true;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-zA-Z])/g, '$1 $2')
    .split(/[-_.\s/:]+/)
    .filter(Boolean);
  return words.some(word => SENSITIVE_KEY_WORD.test(word));
}

const NON_SECRET_CONFIG_VALUES =
  /^(?:true|false|yes|no|null|none|undefined|on|off|0|1|dev|development|prod|production|test|testing|stage|staging|local|debug|info|warn|warning|error|trace|utf-?8|ascii|json|text|html)$/i;

/**
 * Register only credentials and secret-bearing values from config maps (such as MCP `env` or `headers`),
 * avoiding short or benign config strings like `"1"`, `"dev"`, `"info"`, `"true"`, or `"application/json"`.
 */
export function registerConfigSecrets(entries: Record<string, string>, register: (secret: string) => void): void {
  if (!entries || typeof entries !== 'object') return;
  const emit = (candidate: string) => {
    const normalized = candidate.trim();
    if (normalized.length >= 4 && !NON_SECRET_CONFIG_VALUES.test(normalized)) register(normalized);
  };
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;

    let registeredWhole = false;
    const authMatch = AUTH_SCHEME_VALUE.exec(trimmed);
    if (authMatch) {
      emit(trimmed);
      registeredWhole = true;
      const credential = authMatch[1];
      if (credential) emit(credential);
    }

    const urlMatch = URL_USER_PASSWORD.exec(trimmed);
    if (urlMatch?.[1]) {
      const rawPassword = urlMatch[1];
      const decodedPassword = safeDecodeURIComponent(rawPassword);
      emit(rawPassword);
      if (decodedPassword !== rawPassword) emit(decodedPassword);
    }

    if (!registeredWhole && (isSensitiveConfigKey(key) || SECRET_VALUE_PATTERN.test(trimmed))) emit(trimmed);
  }
}

export class Redactor {
  private readonly secrets = new Set<string>();
  register(secret: string) {
    if (!secret || secret.trim().length < 3) return;
    this.secrets.add(secret);
  }
  text(value: string): string {
    let result = value;
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length))
      result = result.split(secret).join('[REDACTED]');
    return result.replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]').replace(/\bsk-[\w-]+/g, '[REDACTED]');
  }
  stream() {
    let pending = '';
    const dynamicReserve = (text: string): number => {
      // Withhold trailing incomplete dynamic-secret tokens so chunk boundaries cannot leak Bearer/sk- values.
      const tail = text.slice(-256);
      const patterns = [
        /(?:^|[\s"'=:(])(Bearer\s+[^\s"']*)$/i,
        /(?:^|[\s"'=:(])(Bearer\s*)$/i,
        /(?:^|[\s"'=:(])(B|Be|Bea|Bear|Beare)$/i,
        /\b(sk-[\w-]*)$/,
        /\b(sk)$/,
      ];
      let best = 0;
      for (const pattern of patterns) {
        const match = pattern.exec(tail);
        if (match?.[1] && match[1].length > best) best = match[1].length;
      }
      return best;
    };
    return {
      push: (chunk: string) => {
        let safe = pending + chunk;
        for (const secret of [...this.secrets].sort((a, b) => b.length - a.length))
          safe = safe.split(secret).join('[REDACTED]');
        let reserve = dynamicReserve(safe);
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
