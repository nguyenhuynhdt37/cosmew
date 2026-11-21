/** One server from the user file `~/.cosmew/mcp.json` (or `COSMEW_HOME/mcp.json`; legacy roots remain supported). */
export type McpServerSpec =
  | {name: string; transport: 'stdio'; command: string; args: string[]; env: Record<string, string>}
  | {name: string; transport: 'http'; url: string; headers: Record<string, string>};

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,64}$/;
/** Shell metacharacters never belong in the executable. Arguments stay separate argv entries. */
const SHELL_META = /[\n\r\0;&|`$<>]/;

export interface McpConfigParse {
  servers: McpServerSpec[];
  problems: string[];
}

/** `mcp__server__tool`, or null when the pair cannot be a permission-rule target of at most 100 characters. */
export function qualifiedMcpName(server: string, tool: string): string | null {
  if (!SERVER_NAME.test(server) || !TOOL_NAME.test(tool)) return null;
  const name = `mcp__${server}__${tool}`;
  return name.length <= 100 ? name : null;
}

/**
 * Claude-style `mcpServers` object. Stdio is `{command, args?, env?}`. HTTP is `{url, headers?}`
 * (`type` `http` or absent). `sse` is rejected. Values are literal: nothing is shell-expanded.
 * This function does not read a file and does not start a process.
 */
export function parseMcpConfig(text: string): McpConfigParse {
  const problems: string[] = [];
  const servers: McpServerSpec[] = [];
  if (text.length > 256 * 1024) return {servers, problems: ['mcp.json is larger than 256 KiB and was not loaded.']};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {servers, problems: ['mcp.json is not valid JSON.']};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return {servers, problems: ['mcp.json must be an object.']};
  const root = parsed as Record<string, unknown>;
  const listed = root.mcpServers;
  if (listed === undefined) return {servers, problems: ['mcp.json has no mcpServers object.']};
  if (!listed || typeof listed !== 'object' || Array.isArray(listed))
    return {servers, problems: ['mcpServers must be an object.']};
  const entries = Object.entries(listed as Record<string, unknown>);
  if (entries.length > 16) problems.push('Only the first 16 MCP servers are loaded.');
  const seen = new Set<string>();
  for (const [name, value] of entries.slice(0, 16)) {
    if (!SERVER_NAME.test(name)) {
      problems.push('One server name was skipped (use letters, digits, "_" and "-", at most 32).');
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      problems.push(`${name}: server entry must be an object.`);
      continue;
    }
    const entry = value as Record<string, unknown>;
    const type = typeof entry.type === 'string' ? entry.type : undefined;
    if (type === 'sse' || type === 'websocket') {
      problems.push(`${name}: ${type} transport is not supported.`);
      continue;
    }
    const spec = entry.url !== undefined ? httpServer(name, entry, problems) : stdioServer(name, entry, problems);
    if (spec) servers.push(spec);
  }
  return {servers, problems};
}

function stdioServer(name: string, entry: Record<string, unknown>, problems: string[]): McpServerSpec | undefined {
  if (typeof entry.command !== 'string' || !entry.command.trim()) {
    problems.push(`${name}: needs a command or an http(s) url.`);
    return;
  }
  const command = entry.command.trim();
  if (command.startsWith('-') || SHELL_META.test(command) || command.length > 1024) {
    problems.push(`${name}: command must be one executable, not a shell line.`);
    return;
  }
  if (entry.args !== undefined && !Array.isArray(entry.args)) {
    problems.push(`${name}: args must be an array of strings.`);
    return;
  }
  const args: string[] = [];
  for (const arg of (entry.args ?? []).slice(0, 64)) {
    if (typeof arg !== 'string' || SHELL_META.test(arg) || arg.length > 1024) {
      problems.push(`${name}: an argument was rejected.`);
      return;
    }
    args.push(arg);
  }
  if (Array.isArray(entry.args) && entry.args.length > 64)
    problems.push(`${name}: only the first 64 arguments are used.`);
  const env: Record<string, string> = {};
  if (entry.env !== undefined) {
    if (!entry.env || typeof entry.env !== 'object' || Array.isArray(entry.env)) {
      problems.push(`${name}: env must be an object of strings.`);
      return;
    }
    const pairs = Object.entries(entry.env as Record<string, unknown>).slice(0, 32);
    for (const [key, value] of pairs) {
      if (!ENV_KEY.test(key) || typeof value !== 'string' || value.length > 4096 || SHELL_META.test(value)) {
        problems.push(`${name}: one env entry was rejected.`);
        continue;
      }
      env[key] = value;
    }
  }
  return {name, transport: 'stdio', command, args, env};
}

function httpServer(name: string, entry: Record<string, unknown>, problems: string[]): McpServerSpec | undefined {
  if (typeof entry.url !== 'string') {
    problems.push(`${name}: url must be a string.`);
    return;
  }
  let url: URL;
  try {
    url = new URL(entry.url);
  } catch {
    problems.push(`${name}: url is not valid.`);
    return;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    problems.push(`${name}: url must be http(s) without credentials or a fragment.`);
    return;
  }
  const headers: Record<string, string> = {};
  if (entry.headers !== undefined) {
    if (!entry.headers || typeof entry.headers !== 'object' || Array.isArray(entry.headers)) {
      problems.push(`${name}: headers must be an object of strings.`);
      return;
    }
    for (const [key, value] of Object.entries(entry.headers as Record<string, unknown>).slice(0, 16)) {
      if (!/^[\w-]{1,64}$/.test(key) || typeof value !== 'string' || value.length > 4096 || /[\n\r\0]/.test(value)) {
        problems.push(`${name}: one header was rejected.`);
        continue;
      }
      headers[key] = value;
    }
  }
  return {name, transport: 'http', url: url.toString(), headers};
}
