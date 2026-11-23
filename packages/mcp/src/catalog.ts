/** Metadata only. No command, package argument or header from a publisher is executed. */
export type McpCatalogRecipe =
  | {kind: 'remote'; url: string}
  | {kind: 'npm'; packageName: string; version: string}
  | {kind: 'manual'; reason: string};
export interface McpCatalogEntry {
  id: string;
  name: string;
  description: string;
  version?: string;
  sourceUrl?: string;
  tested: false;
  registryListed: boolean;
  recipes: McpCatalogRecipe[];
}
export interface McpCatalogPage {
  entries: McpCatalogEntry[];
  nextCursor?: string;
}
export const OFFICIAL_MCP_REGISTRY = 'https://registry.modelcontextprotocol.io';
const MAX_BYTES = 512 * 1024;
export const MCP_NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
export const MCP_EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const plain = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, limit) : '';

/** URLs in search results are data, never fetch targets. Reject ambient/private endpoint hints. */
export function publicMcpMetadataUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      !host.includes('.') ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      /^[\d.]+$/.test(host) ||
      host.includes(':') ||
      host.startsWith('[')
    )
      return;
    return url.toString();
  } catch {
    return;
  }
}

export async function readBoundedMcpJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('Metadata request failed.');
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Metadata exceeds size limit.');
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', abort, {once: true});
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BYTES) throw new Error('Metadata exceeds size limit.');
      chunks.push(part.value);
    }
    signal?.throwIfAborted();
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
  }
}

function entryFromMetadata(value: unknown): McpCatalogEntry | undefined {
  const envelope = record(value);
  const registryMeta = record(record(envelope._meta)['io.modelcontextprotocol.registry/official']);
  const status = registryMeta.status ?? record(envelope._meta).status;
  if (status !== undefined && status !== 'active') return;
  const server = record(envelope.server);
  const id = plain(server.name, 256);
  if (!id || id !== server.name) return;
  const recipes: McpCatalogRecipe[] = [];
  for (const remote of (Array.isArray(server.remotes) ? server.remotes : []).slice(0, 8)) {
    const item = record(remote);
    const url = publicMcpMetadataUrl(item.url);
    if (item.type === 'streamable-http' && url) recipes.push({kind: 'remote', url});
  }
  for (const pkg of (Array.isArray(server.packages) ? server.packages : []).slice(0, 8)) {
    const item = record(pkg);
    if (
      item.registryType === 'npm' &&
      record(item.transport).type === 'stdio' &&
      (item.registryBaseUrl === undefined || item.registryBaseUrl === 'https://registry.npmjs.org') &&
      typeof item.identifier === 'string' &&
      MCP_NPM_NAME.test(item.identifier) &&
      typeof item.version === 'string' &&
      MCP_EXACT_VERSION.test(item.version) &&
      !item.runtimeArguments &&
      !item.packageArguments &&
      !item.environmentVariables
    )
      recipes.push({kind: 'npm', packageName: item.identifier, version: item.version});
  }
  if (!recipes.length)
    recipes.push({kind: 'manual', reason: 'Transport, package format or required setup needs manual configuration.'});
  const sourceUrl = publicMcpMetadataUrl(record(server.repository).url);
  return {
    id,
    name: plain(server.title, 128) || id,
    description: plain(server.description, 2048),
    version: plain(server.version, 128) || undefined,
    ...(sourceUrl ? {sourceUrl} : {}),
    tested: false,
    registryListed: true,
    recipes,
  };
}

export class McpCatalog {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async search(query: string, options: {signal?: AbortSignal; cursor?: string} = {}): Promise<McpCatalogPage> {
    if (query.length > 256 || (options.cursor?.length ?? 0) > 2048) throw new Error('Search input exceeds limit.');
    const url = new URL('/v0.1/servers', OFFICIAL_MCP_REGISTRY);
    url.searchParams.set('search', query);
    url.searchParams.set('version', 'latest');
    url.searchParams.set('limit', '30');
    if (options.cursor) url.searchParams.set('cursor', options.cursor);
    const data = record(await this.request(url, options.signal));
    const entries = (Array.isArray(data.servers) ? data.servers : [])
      .slice(0, 30)
      .map(entryFromMetadata)
      .filter((entry): entry is McpCatalogEntry => !!entry);
    const cursor = plain(record(data.metadata).nextCursor, 2048);
    return {entries, ...(cursor ? {nextCursor: cursor} : {})};
  }
  async get(id: string, version = 'latest', options: {signal?: AbortSignal} = {}): Promise<McpCatalogEntry> {
    if (!id || id.length > 256 || version.length > 128) throw new Error('Invalid catalog identity.');
    const url = new URL(
      `/v0.1/servers/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`,
      OFFICIAL_MCP_REGISTRY,
    );
    const entry = entryFromMetadata(await this.request(url, options.signal));
    if (!entry || entry.id !== id) throw new Error('Catalog identity mismatch.');
    return entry;
  }
  private async request(url: URL, signal?: AbortSignal): Promise<unknown> {
    const bounded = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
    try {
      return await readBoundedMcpJson(
        await this.fetcher(url, {signal: bounded, redirect: 'error', headers: {Accept: 'application/json'}}),
        bounded,
      );
    } catch {
      signal?.throwIfAborted();
      throw new Error('MCP registry request failed or returned invalid metadata.');
    }
  }
}

/** Candidates only; no service has a Cosmew-tested badge without real acceptance evidence. */
export function recommendedMcpRecipes(): McpCatalogEntry[] {
  const candidates = [
    [
      'context7',
      'Context7',
      'Current library documentation',
      'https://github.com/upstash/context7',
      'https://mcp.context7.com/mcp',
    ],
    [
      'github',
      'GitHub',
      'Issues and pull request workflows',
      'https://github.com/github/github-mcp-server',
      'https://api.githubcopilot.com/mcp/',
    ],
    ['browser', 'Playwright', 'Browser testing', 'https://github.com/microsoft/playwright-mcp', ''],
    [
      'figma',
      'Figma',
      'Design workflows',
      'https://developers.figma.com/docs/figma-mcp-server/',
      'https://mcp.figma.com/mcp',
    ],
    [
      'sentry',
      'Sentry',
      'Incident investigation',
      'https://docs.sentry.io/product/sentry-mcp/',
      'https://mcp.sentry.dev/mcp',
    ],
    [
      'openai-docs',
      'OpenAI Docs',
      'OpenAI API documentation',
      'https://developers.openai.com/resources/docs-mcp',
      'https://developers.openai.com/mcp',
    ],
  ];
  return candidates.map(([id, name, description, sourceUrl, url]) => ({
    id: id!,
    name: name!,
    description: description!,
    sourceUrl: sourceUrl!,
    tested: false,
    registryListed: false,
    recipes: url
      ? [{kind: 'remote', url}]
      : [
          {
            kind: 'manual',
            reason: 'Select an exact published npm version and verified integrity lock before installation.',
          },
        ],
  }));
}
