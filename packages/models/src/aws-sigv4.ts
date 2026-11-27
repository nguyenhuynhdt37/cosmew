import {createHash, createHmac} from 'node:crypto';

export interface AwsSigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AwsSigV4SignInput {
  method: string;
  url: URL;
  headers: Headers;
  body?: Uint8Array | string | null;
  service: string;
  region: string;
  credentials: AwsSigV4Credentials;
  now?: Date;
}

const EXCLUDED_SIGNED_HEADERS = new Set([
  'authorization',
  'connection',
  'expect',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'x-amzn-trace-id',
]);

/** RFC 3986 percent-encoding with uppercase hex digits (AWS SigV4 specification). */
export function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Build the SigV4 canonical URI. Non-S3 services (including Amazon Bedrock, whose model IDs
 * commonly contain `:` encoded as `%3A`) require double URI-encoding of each path segment.
 */
export function canonicalAwsUri(pathname: string, service: string): string {
  const normalized = pathname || '/';
  if (normalized === '/') return '/';
  const doubleEncode = service !== 's3';
  const segments = normalized.split('/').map(segment => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      /* Preserve non-UTF8 / raw percent sequences verbatim. */
    }
    const once = awsUriEncode(decoded);
    return doubleEncode ? awsUriEncode(once) : once;
  });
  return segments.join('/') || '/';
}

/** Build the sorted SigV4 canonical query string. */
export function canonicalAwsQuery(searchParams: URLSearchParams): string {
  const pairs: [string, string][] = [];
  for (const [key, value] of searchParams.entries()) {
    pairs.push([awsUriEncode(key), awsUriEncode(value)]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: Uint8Array | string, data: string): Uint8Array {
  return createHmac('sha256', key).update(data).digest();
}

function formatAmzDate(date: Date): {amzDate: string; dateStamp: string} {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return {amzDate: iso, dateStamp: iso.slice(0, 8)};
}

function hostHeaderValue(url: URL): string {
  const isDefaultPort =
    !url.port || (url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80');
  return isDefaultPort ? url.hostname : `${url.hostname}:${url.port}`;
}

/**
 * Sign an HTTP request with AWS Signature Version 4 (`AWS4-HMAC-SHA256`) and apply the
 * resulting `host`, `x-amz-date`, `x-amz-content-sha256`, optional `x-amz-security-token`,
 * and `authorization` headers in-place.
 */
export function signAwsSigV4(input: AwsSigV4SignInput): {
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  authorization: string;
  amzDate: string;
  payloadHash: string;
} {
  const method = input.method.toUpperCase();
  const now = input.now ?? new Date();
  const {amzDate, dateStamp} = formatAmzDate(now);
  const payloadBytes =
    input.body == null
      ? new Uint8Array(0)
      : typeof input.body === 'string'
        ? Buffer.from(input.body, 'utf8')
        : input.body;
  const payloadHash = sha256Hex(payloadBytes);

  const headers = input.headers;
  headers.delete('authorization');
  headers.set('host', hostHeaderValue(input.url));
  headers.set('x-amz-date', amzDate);
  headers.set('x-amz-content-sha256', payloadHash);
  if (input.credentials.sessionToken) {
    headers.set('x-amz-security-token', input.credentials.sessionToken);
  } else {
    headers.delete('x-amz-security-token');
  }

  const normalizedHeaders = new Map<string, string>();
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (EXCLUDED_SIGNED_HEADERS.has(key)) return;
    const cleaned = value.trim().replace(/\s+/g, ' ');
    const prev = normalizedHeaders.get(key);
    normalizedHeaders.set(key, prev === undefined ? cleaned : `${prev},${cleaned}`);
  });
  const sortedNames = [...normalizedHeaders.keys()].sort();
  const canonicalHeaders = sortedNames.map(name => `${name}:${normalizedHeaders.get(name)}\n`).join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalRequest = [
    method,
    canonicalAwsUri(input.url.pathname, input.service),
    canonicalAwsQuery(input.url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmacSha256(`AWS4${input.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, input.region);
  const kService = hmacSha256(kRegion, input.service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  headers.set('authorization', authorization);
  return {canonicalRequest, stringToSign, signature, authorization, amzDate, payloadHash};
}
