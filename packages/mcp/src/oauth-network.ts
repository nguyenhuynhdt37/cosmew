import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {lookup} from 'node:dns/promises';
import {BlockList, isIP} from 'node:net';

export type McpOAuthLookup = (hostname: string) => Promise<readonly {address: string; family: number}[]>;
const privateAddresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  privateAddresses.addSubnet(network, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
privateAddresses.addSubnet('2001::', 23, 'ipv6');
privateAddresses.addSubnet('2001:db8::', 32, 'ipv6');
privateAddresses.addSubnet('2002::', 16, 'ipv6');
export function isMcpLoopback(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/** Preflight every OAuth HTTP target before the SDK can fetch discovered URLs. */
export async function validateMcpOAuthFetchTarget(
  root: URL,
  target: URL,
  resolve: McpOAuthLookup = hostname => lookup(hostname, {all: true, verbatim: true}),
  cancellation?: AbortSignal | null,
): Promise<{address: string; family: number}> {
  const reject = () => {
    throw new Error('MCP_OAUTH_NETWORK_DENIED');
  };
  const signal = cancellation
    ? AbortSignal.any([cancellation, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  if (signal.aborted) reject();
  if (target.username || target.password || target.hash) reject();
  if (isMcpLoopback(target)) {
    if (!isMcpLoopback(root) || !['http:', 'https:'].includes(target.protocol)) reject();
    return {address: target.hostname === '[::1]' ? '::1' : '127.0.0.1', family: target.hostname === '[::1]' ? 6 : 4};
  }
  if (target.protocol !== 'https:') reject();
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{address: host, family: isIP(host)}]
    : await new Promise<readonly {address: string; family: number}[]>((accept, rejectLookup) => {
        const aborted = () => rejectLookup(new Error('MCP_OAUTH_NETWORK_DENIED'));
        signal.addEventListener('abort', aborted, {once: true});
        Promise.resolve()
          .then(() => {
            if (signal.aborted) throw new Error('MCP_OAUTH_NETWORK_DENIED');
            return resolve(host);
          })
          .then(accept, rejectLookup)
          .finally(() => signal.removeEventListener('abort', aborted));
      });
  if (signal.aborted) reject();
  if (!addresses.length) reject();
  for (const {address, family} of addresses) {
    if (family === 4) {
      if (isIP(address) !== 4 || privateAddresses.check(address, 'ipv4')) reject();
    } else if (family === 6) {
      if (isIP(address) !== 6 || !globalV6.check(address, 'ipv6') || privateAddresses.check(address, 'ipv6')) reject();
    } else reject();
  }
  return addresses[0]!;
}

/** OAuth requests pin the validated DNS answer while retaining hostname, Host and TLS verification. */
export async function pinnedMcpOAuthFetch(
  root: URL,
  target: URL,
  init: RequestInit = {},
  resolve?: McpOAuthLookup,
  requestFactory?: typeof httpsRequest,
): Promise<Response> {
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  const selected = await validateMcpOAuthFetchTarget(root, target, resolve, signal);
  if (signal.aborted) throw new Error('MCP_OAUTH_NETWORK_DENIED');
  let body: string | Uint8Array | undefined;
  if (init.body instanceof URLSearchParams) body = init.body.toString();
  else if (typeof init.body === 'string' || init.body instanceof Uint8Array) body = init.body;
  else if (init.body != null) throw new Error('MCP_OAUTH_NETWORK_DENIED');
  return new Promise<Response>((resolveResponse, reject) => {
    const headers = new Headers(init.headers);
    if (init.body instanceof URLSearchParams && !headers.has('content-type'))
      headers.set('content-type', 'application/x-www-form-urlencoded');
    const request = (requestFactory ?? (target.protocol === 'https:' ? httpsRequest : httpRequest))(
      target,
      {
        method: init.method ?? 'GET',
        headers: Object.fromEntries(headers),
        signal,
        // Disabling pooling forces every socket through this operation's validated address.
        agent: false,
        ...(target.protocol === 'https:' ? {servername: target.hostname} : {}),
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{address: selected.address, family: selected.family}]);
          else callback(null, selected.address, selected.family);
        },
      },
      response => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 256 * 1024) {
            request.destroy(new Error('MCP_OAUTH_RESPONSE_TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const status = response.statusCode ?? 500;
          if (status >= 300 && status < 400) {
            reject(new Error('MCP_OAUTH_REDIRECT_DENIED'));
            return;
          }
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) for (const part of value) responseHeaders.append(key, part);
            else if (value !== undefined) responseHeaders.set(key, value);
          }
          try {
            resolveResponse(
              new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
                status,
                headers: responseHeaders,
              }),
            );
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}
