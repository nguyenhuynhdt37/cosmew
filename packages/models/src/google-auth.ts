import {createHash, createSign} from 'node:crypto';
import {lstatSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {FutrynError} from '@cosmew/contracts';

const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const TOKEN_EXCHANGE_TIMEOUT_MS = 15_000;
const REFRESH_MARGIN_MS = 60_000;
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

const ALLOWED_GOOGLE_TOKEN_URIS = new Set([
  'https://oauth2.googleapis.com/token',
  'https://www.googleapis.com/oauth2/v4/token',
]);

export interface GoogleAdcTokenOptions {
  credentialFile?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  fetchImpl?: typeof fetch;
  /** Override allowed token endpoint strictly for deterministic local unit tests. */
  tokenEndpointOverride?: string;
  now?: () => number;
  onSecret?: (secret: string) => void;
  signal?: AbortSignal;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function resolveCredentialPath(
  configured: string | undefined,
  env: Record<string, string | undefined>,
  homeDir: string,
): string {
  const raw = configured?.trim() || env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (raw) {
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(raw)) throw new FutrynError('POLICY');
    if (raw.startsWith('~/')) return join(homeDir, raw.slice(2));
    if (!isAbsolute(raw)) throw new FutrynError('POLICY');
    return raw;
  }
  return join(homeDir, '.config', 'gcloud', 'application_default_credentials.json');
}

function validateTokenUri(raw: unknown, override?: string): string {
  if (override) {
    const parsed = new URL(override);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) throw new FutrynError('POLICY');
    return parsed.href;
  }
  const uri = typeof raw === 'string' && raw.trim() ? raw.trim() : 'https://oauth2.googleapis.com/token';
  if (!ALLOWED_GOOGLE_TOKEN_URIS.has(uri)) throw new FutrynError('POLICY');
  return uri;
}

/** Create a signed RS256 JWT assertion for Google Cloud Service Account OAuth2 exchange. */
export function createGoogleServiceAccountJwt(input: {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
  scope?: string;
  nowSec: number;
}): string {
  const header = base64Url(JSON.stringify({alg: 'RS256', typ: 'JWT'}));
  const payload = base64Url(
    JSON.stringify({
      iss: input.clientEmail,
      sub: input.clientEmail,
      scope: input.scope ?? CLOUD_PLATFORM_SCOPE,
      aud: input.tokenUri,
      iat: input.nowSec,
      exp: input.nowSec + 3600,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = base64Url(signer.sign(input.privateKey));
  return `${signingInput}.${signature}`;
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new FutrynError('PROTOCOL');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TOKEN_RESPONSE_BYTES) {
        await reader.cancel();
        throw new FutrynError('PROTOCOL');
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new FutrynError('PROTOCOL');
  return parsed as Record<string, unknown>;
}

/**
 * Pure Node/Bun Google Cloud ADC token exchanger (zero dependency on `google-auth-library`).
 * Supports `service_account` (RS256 JWT bearer grant) and `authorized_user` (refresh_token grant).
 * Never queries GCE link-local metadata endpoints (`169.254.169.254`) or follows HTTP redirects.
 */
export class GoogleAdcTokenProvider {
  private readonly cache = new Map<string, {token: string; expiresAt: number}>();

  invalidate(): void {
    this.cache.clear();
  }

  async getAccessToken(options: GoogleAdcTokenOptions = {}): Promise<string> {
    if (options.signal?.aborted) throw new FutrynError('CANCELLED');
    const env = options.env ?? process.env;
    const homeDir = options.homeDir ?? homedir();
    const now = options.now ?? Date.now;
    const fetchImpl = options.fetchImpl ?? fetch;

    const path = resolveCredentialPath(options.credentialFile, env, homeDir);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      throw new FutrynError('AUTH');
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_CREDENTIAL_FILE_BYTES) {
      throw new FutrynError('POLICY');
    }

    let rawText: string;
    try {
      rawText = readFileSync(path, 'utf8');
    } catch {
      throw new FutrynError('AUTH');
    }

    const fingerprint = createHash('sha256')
      .update(JSON.stringify([path, stat.size, stat.mtimeMs, rawText.length, options.tokenEndpointOverride ?? '']))
      .digest('hex');

    const cached = this.cache.get(fingerprint);
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now()) {
      options.onSecret?.(cached.token);
      return cached.token;
    }

    let parsed: Record<string, unknown>;
    try {
      const json: unknown = JSON.parse(rawText);
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error();
      parsed = json as Record<string, unknown>;
    } catch {
      throw new FutrynError('AUTH');
    }

    let tokenUri: string;
    let bodyParams: URLSearchParams;

    if (parsed.type === 'service_account') {
      const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '';
      const privateKey = typeof parsed.private_key === 'string' ? parsed.private_key : '';
      if (!clientEmail || !privateKey) throw new FutrynError('AUTH');
      options.onSecret?.(privateKey);
      tokenUri = validateTokenUri(parsed.token_uri, options.tokenEndpointOverride);
      let assertion: string;
      try {
        assertion = createGoogleServiceAccountJwt({
          clientEmail,
          privateKey,
          tokenUri,
          nowSec: Math.floor(now() / 1000),
        });
      } catch {
        throw new FutrynError('AUTH');
      }
      bodyParams = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      });
    } else if (parsed.type === 'authorized_user') {
      const clientId = typeof parsed.client_id === 'string' ? parsed.client_id.trim() : '';
      const clientSecret = typeof parsed.client_secret === 'string' ? parsed.client_secret.trim() : '';
      const refreshToken = typeof parsed.refresh_token === 'string' ? parsed.refresh_token.trim() : '';
      if (!clientId || !clientSecret || !refreshToken) throw new FutrynError('AUTH');
      options.onSecret?.(clientSecret);
      options.onSecret?.(refreshToken);
      tokenUri = validateTokenUri(parsed.token_uri, options.tokenEndpointOverride);
      bodyParams = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      });
    } else {
      throw new FutrynError('AUTH');
    }

    const combined = AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    ]);
    let response: Response;
    try {
      response = await fetchImpl(tokenUri, {
        method: 'POST',
        headers: {'content-type': 'application/x-www-form-urlencoded'},
        body: bodyParams.toString(),
        redirect: 'error',
        credentials: 'omit',
        signal: combined,
      });
    } catch {
      if (options.signal?.aborted) throw new FutrynError('CANCELLED');
      if (combined.aborted) throw new FutrynError('TIMEOUT');
      throw new FutrynError('TRANSPORT', true);
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 400 || response.status === 401 || response.status === 403) throw new FutrynError('AUTH');
      if (response.status === 429) throw new FutrynError('RATE_LIMIT', true);
      throw new FutrynError('TRANSPORT', response.status >= 500);
    }

    const payload = await readBoundedJson(response);
    const accessToken = typeof payload.access_token === 'string' ? payload.access_token.trim() : '';
    const expiresIn =
      typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in) && payload.expires_in > 0
        ? Math.min(payload.expires_in, 86_400)
        : 3600;
    if (!accessToken || /[\r\n\x00-\x1f\x7f\s]/.test(accessToken)) throw new FutrynError('PROTOCOL');

    options.onSecret?.(accessToken);
    this.cache.set(fingerprint, {token: accessToken, expiresAt: now() + expiresIn * 1000});
    return accessToken;
  }
}
