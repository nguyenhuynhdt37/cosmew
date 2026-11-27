import {lookup} from 'node:dns/promises';
import {createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {connect, isIP, type Socket} from 'node:net';

/**
 * The sandbox network gate (ADR 0061, Claude Code's sandbox proxy). Commands in the OS sandbox have
 * no direct network: Seatbelt lets them reach only loopback, which includes this proxy. HTTPS goes
 * through `CONNECT host:port` (a tunnel, no TLS interception), plain HTTP through absolute-URI
 * requests. Every new host asks `decide`; an allowed one is resolved HERE and the connection is
 * pinned to the answer, so a hostname that resolves to a private, loopback or link-local address is
 * refused (no DNS rebinding into the LAN or a metadata service). Pure Node built-ins.
 */

export interface ProxyTarget {
  host: string;
  port: number;
}

export interface ProxyEvent extends ProxyTarget {
  allowed: boolean;
  reason: 'allowed' | 'denied' | 'private-address' | 'unresolved' | 'invalid-target';
}

export interface SandboxProxyOptions {
  /** Is this host allowed? Resolve `false` for deny. Must never throw; a throw denies. */
  decide(target: ProxyTarget, signal: AbortSignal): Promise<boolean>;
  /** Audit hook: every decision. */
  onEvent?(event: ProxyEvent): void;
  /** Test seam for DNS. */
  resolve?(host: string): Promise<string[]>;
  /** Test seam: rewrite the pinned, already vetted destination (production connects to it as is). */
  dial?(address: string, port: number): {address: string; port: number};
  maxConnections?: number;
  idleTimeoutMs?: number;
}

const ipv4 = (address: string) => address.split('.').map(Number) as [number, number, number, number];

function isPrivateIpv4(a: number, b: number, c: number, _d: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function parseIpv6Hextets(address: string): number[] | null {
  const raw = address.toLowerCase().split('%')[0] ?? '';
  if (!raw || raw.includes(':::')) return null;
  let normalized = raw;
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    if (lastColon === -1) return null;
    const v4Part = normalized.slice(lastColon + 1);
    if (isIP(v4Part) !== 4) return null;
    const [a, b, c, d] = ipv4(v4Part);
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
    normalized = `${normalized.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const parseGroup = (part: string): number[] | null => {
    if (!part) return [];
    const groups = part.split(':');
    const out: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const left = parseGroup(halves[0]!);
  if (!left) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const right = parseGroup(halves[1]!);
  if (!right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

/** Loopback, private, link-local, CGNAT, multicast, transition and reserved addresses (IPv4 and IPv6). */
export function isPrivateAddress(address: string): boolean {
  const lower = address.trim().toLowerCase();
  const bare = lower.split('%')[0] ?? '';
  if (isIP(bare) === 4) {
    const [a, b, c, d] = ipv4(bare);
    return isPrivateIpv4(a, b, c, d);
  }
  if (isIP(bare) === 6) {
    const hextets = parseIpv6Hextets(bare);
    if (!hextets) return true;
    const [h0, h1, h2] = hextets as [number, number, number, number, number, number, number, number];
    // Only global unicast 2000::/3 may ever be public; everything else (loopback ::1, unspecified ::,
    // IPv4-mapped ::ffff:0:0/96, IPv4-compatible, NAT64 64:ff9b::/96, ULA fc00::/7, link-local fe80::/10,
    // multicast ff00::/8, etc.) is rejected.
    if ((h0 & 0xe000) !== 0x2000) return true;
    // Reject special-purpose and transition ranges inside 2000::/3 (Teredo, BMWG, ORCHID, docs, 6to4).
    if (h0 === 0x2001 && h1 === 0x0000) return true;
    if (h0 === 0x2001 && h1 === 0x0002 && h2 === 0x0000) return true;
    if (h0 === 0x2001 && ((h1 & 0xfff0) === 0x0010 || (h1 & 0xfff0) === 0x0020)) return true;
    if (h0 === 0x2001 && h1 === 0x0db8) return true;
    if (h0 === 0x2002) return true;
    if (h0 === 0x3fff && (h1 & 0xf000) === 0x0000) return true;
    return false;
  }
  return true;
}

const defaultResolve = async (host: string): Promise<string[]> =>
  (await lookup(host, {all: true, verbatim: true})).map(entry => entry.address);

const HOST_PATTERN = /^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/i;

/** `host:port` of a CONNECT target, or `null` when it is not a plain name or address. */
export function parseConnectTarget(text: string): ProxyTarget | null {
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:\s]+):(\d{1,5})$/.exec(text.trim());
  if (!match) return null;
  const host = match[1]!
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  const port = Number(match[2]);
  if (!host || !HOST_PATTERN.test(match[1]!) || port < 1 || port > 65535) return null;
  return {host, port};
}

export class SandboxProxy {
  private server: Server | undefined;
  private starting: Promise<string> | undefined;
  private readonly sockets = new Set<Socket>();
  private readonly resolve: (host: string) => Promise<string[]>;

  constructor(private readonly options: SandboxProxyOptions) {
    this.resolve = options.resolve ?? defaultResolve;
  }

  /** Start once; resolves the loopback URL commands use as their proxy. */
  start(): Promise<string> {
    this.starting ??= new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => void this.forward(req, res));
      server.on('connect', (req, socket, head) => void this.tunnel(req, socket as Socket, head));
      server.on('clientError', (_error, socket) => socket.destroy());
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        const address = server.address();
        if (address && typeof address === 'object') resolve(`http://127.0.0.1:${address.port}`);
        else reject(new Error('proxy did not bind'));
      });
    }).catch(error => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.starting = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.setTimeout(this.options.idleTimeoutMs ?? 300_000, () => socket.destroy());
    socket.once('close', () => this.sockets.delete(socket));
  }

  /** Allow, resolve and pin: the address to connect to, or the refusal. */
  private async authorize(
    target: ProxyTarget | null,
    signal: AbortSignal,
  ): Promise<{address: string; target: ProxyTarget} | {refusal: string; status: number}> {
    const report = (event: ProxyEvent) => this.options.onEvent?.(event);
    if (!target) return {status: 400, refusal: 'Invalid proxy target.'};
    if (this.sockets.size >= (this.options.maxConnections ?? 256))
      return {status: 503, refusal: 'Too many proxy connections.'};
    let allowed = false;
    try {
      allowed = await this.options.decide(target, signal);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      report({...target, allowed: false, reason: 'denied'});
      return {status: 403, refusal: `Network access to ${target.host} was denied by the Cosmew sandbox.`};
    }
    let addresses: string[];
    try {
      addresses = isIP(target.host) ? [target.host] : await this.resolve(target.host);
    } catch {
      addresses = [];
    }
    if (!addresses.length) {
      report({...target, allowed: false, reason: 'unresolved'});
      return {status: 502, refusal: `Could not resolve ${target.host}.`};
    }
    // One private answer poisons the set: the connection must never be steerable into the LAN.
    if (addresses.some(isPrivateAddress)) {
      report({...target, allowed: false, reason: 'private-address'});
      return {
        status: 403,
        refusal: `${target.host} resolves to a private or local address; the sandbox proxy does not reach those. Local servers are reached directly (localhost).`,
      };
    }
    report({...target, allowed: true, reason: 'allowed'});
    return {address: addresses[0]!, target};
  }

  private async tunnel(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    this.track(client);
    client.on('error', () => client.destroy());
    const controller = new AbortController();
    client.once('close', () => controller.abort());
    const result = await this.authorize(parseConnectTarget(req.url ?? ''), controller.signal);
    if ('refusal' in result) {
      if (!client.destroyed)
        client.end(
          `HTTP/1.1 ${result.status} Refused\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${result.refusal}\n`,
        );
      return;
    }
    if (client.destroyed) return;
    const dest = this.options.dial?.(result.address, result.target.port) ?? {
      address: result.address,
      port: result.target.port,
    };
    const upstream = connect({host: dest.address, port: dest.port});
    this.track(upstream);
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => {
      if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      upstream.destroy();
    });
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
  }

  private async forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.socket) this.track(req.socket);
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    let url: URL | undefined;
    try {
      url = new URL(req.url ?? '');
    } catch {
      /* origin-form request: not a proxy request */
    }
    const fail = (status: number, text: string) => {
      if (!res.headersSent) res.writeHead(status, {'Content-Type': 'text/plain', Connection: 'close'});
      res.end(text + '\n');
    };
    if (!url || url.protocol !== 'http:' || url.username || url.password)
      return fail(400, 'The Cosmew sandbox proxy forwards http:// URLs and CONNECT tunnels only.');
    const port = url.port ? Number(url.port) : 80;
    const host = url.hostname
      .replace(/^\[|\]$/g, '')
      .toLowerCase()
      .replace(/\.$/, '');
    const result = await this.authorize(
      parseConnectTarget(`${host.includes(':') ? `[${host}]` : host}:${port}`),
      controller.signal,
    );
    if ('refusal' in result) return fail(result.status, result.refusal);
    const dest = this.options.dial?.(result.address, port) ?? {address: result.address, port};
    const headers = {...req.headers};
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    headers.host = url.host;
    const upstream = httpRequest(
      {host: dest.address, port: dest.port, method: req.method, path: url.pathname + url.search, headers},
      response => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.once('socket', socket => this.track(socket));
    upstream.on('error', () => fail(502, 'Bad gateway.'));
    res.once('close', () => upstream.destroy());
    req.pipe(upstream);
  }
}

/** Environment that points a command's HTTP clients at the proxy; loopback stays direct. */
export function proxyEnvironment(url: string): Record<string, string> {
  const noProxy = 'localhost,127.0.0.1,::1,[::1]';
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    all_proxy: url,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}
