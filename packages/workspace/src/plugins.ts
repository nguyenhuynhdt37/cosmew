import {createHash} from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {
  HOOK_EVENTS,
  PLUGIN_ID_PATTERN,
  type ConfiguredHook,
  type HookEventName,
  type PluginAssetCounts,
  type PluginGrantSummary,
  type PluginManifest,
} from '@cosmew/contracts';

export const MAX_PLUGIN_FILE_BYTES = 256 * 1024;
export const MAX_PLUGIN_TOTAL_BYTES = 4 * 1024 * 1024;
export const MAX_PLUGIN_FILES = 256;
export const MAX_INSTALLED_PLUGINS = 64;

const MAX_HOOK_COMMAND_CHARS = 1024;
const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
const MIN_HOOK_TIMEOUT_MS = 1_000;
const MAX_HOOK_TIMEOUT_MS = 60_000;
const MAX_PLUGIN_HOOKS = 64;
const MAX_PLUGIN_MCP_SERVERS = 32;

const MANIFEST_CANDIDATES = [
  'plugin.json',
  join('.cosmew-plugin', 'plugin.json'),
  join('.claude-plugin', 'plugin.json'),
] as const;

const HOOK_EVENT_SET = new Set<string>(HOOK_EVENTS);

export interface ParsedPluginPackage {
  manifest: PluginManifest;
  contentHash: string;
  skillDirs: string[];
  commandDirs: string[];
  agentDirs: string[];
  hooks: ConfiguredHook[];
  rawMcpServers: Record<string, unknown>;
  grants: PluginGrantSummary[];
  counts: PluginAssetCounts;
  diagnostics: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRel(root: string, target: string): string {
  return relative(root, target).split(sep).join('/');
}

function resolveInsidePlugin(pluginRoot: string, rawPath: string): string | undefined {
  if (!rawPath || typeof rawPath !== 'string' || rawPath.includes('\0') || isAbsolute(rawPath)) return undefined;
  const candidate = resolve(pluginRoot, rawPath);
  if (candidate !== pluginRoot && !candidate.startsWith(pluginRoot + sep)) return undefined;
  return candidate;
}

function expandPluginRoot(value: string, pluginRoot: string): string {
  return value.replaceAll('${COSMEW_PLUGIN_ROOT}', pluginRoot).replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
}

function expandPluginRootDeep(value: unknown, pluginRoot: string, depth = 0): unknown {
  if (depth > 8) return value;
  if (typeof value === 'string') return expandPluginRoot(value, pluginRoot);
  if (Array.isArray(value)) return value.map(item => expandPluginRootDeep(item, pluginRoot, depth + 1));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      out[key] = expandPluginRootDeep(item, pluginRoot, depth + 1);
    }
    return out;
  }
  return value;
}

interface ScannedFile {
  relPath: string;
  absPath: string;
  size: number;
}

function scanPluginFiles(pluginRoot: string): {files: ScannedFile[]; error?: string} {
  let rootStat;
  try {
    rootStat = lstatSync(pluginRoot);
  } catch {
    return {files: [], error: 'Plugin directory does not exist.'};
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return {files: [], error: 'Plugin root must be a real directory, not a symlink.'};
  }
  const canonicalRoot = realpathSync(pluginRoot);
  const files: ScannedFile[] = [];
  let totalBytes = 0;

  const walk = (dir: string, depth: number): string | undefined => {
    if (depth > 10) return 'Plugin directory nesting exceeds maximum depth (10).';
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return `Unable to read plugin directory: ${normalizeRel(canonicalRoot, dir) || '.'}`;
    }
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue;
      if (entry.name === '.git' || entry.name === 'node_modules') {
        return `Forbidden directory inside plugin package: ${entry.name}`;
      }
      const abs = join(dir, entry.name);
      let stat;
      try {
        stat = lstatSync(abs);
      } catch {
        return `Unable to inspect plugin entry: ${normalizeRel(canonicalRoot, abs)}`;
      }
      if (stat.isSymbolicLink()) {
        return `Symlinks are forbidden inside plugin packages: ${normalizeRel(canonicalRoot, abs)}`;
      }
      if (stat.isDirectory()) {
        const err = walk(abs, depth + 1);
        if (err) return err;
        continue;
      }
      if (!stat.isFile()) {
        return `Unsupported special file inside plugin package: ${normalizeRel(canonicalRoot, abs)}`;
      }
      if (files.length >= MAX_PLUGIN_FILES) {
        return `Plugin exceeds maximum file count (${MAX_PLUGIN_FILES}).`;
      }
      if (stat.size > MAX_PLUGIN_FILE_BYTES) {
        return `Plugin file exceeds ${MAX_PLUGIN_FILE_BYTES} bytes: ${normalizeRel(canonicalRoot, abs)}`;
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_PLUGIN_TOTAL_BYTES) {
        return `Plugin exceeds maximum total size (${MAX_PLUGIN_TOTAL_BYTES} bytes).`;
      }
      const real = realpathSync(abs);
      if (real !== canonicalRoot && !real.startsWith(canonicalRoot + sep)) {
        return `Plugin file escapes root boundary: ${normalizeRel(canonicalRoot, abs)}`;
      }
      files.push({relPath: normalizeRel(canonicalRoot, abs), absPath: abs, size: stat.size});
    }
    return undefined;
  };

  const err = walk(canonicalRoot, 0);
  if (err) return {files: [], error: err};
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return {files};
}

/** Deterministic SHA-256 over the full sorted file tree and file contents of a plugin directory. */
export function computePluginDirectoryHash(pluginRoot: string): {hash?: string; error?: string} {
  const scanned = scanPluginFiles(pluginRoot);
  if (scanned.error) return {error: scanned.error};
  const hasher = createHash('sha256');
  for (const file of scanned.files) {
    hasher.update(file.relPath);
    hasher.update('\0');
    hasher.update(String(file.size));
    hasher.update('\0');
    hasher.update(readFileSync(file.absPath));
    hasher.update('\n');
  }
  return {hash: hasher.digest('hex')};
}

function parseHooksObject(raw: unknown, pluginId: string, pluginRoot: string, diagnostics: string[]): ConfiguredHook[] {
  const source = isPlainObject(raw) && isPlainObject(raw.hooks) ? raw.hooks : raw;
  if (!isPlainObject(source)) {
    diagnostics.push('Plugin hooks definition must be an object.');
    return [];
  }
  const hooks: ConfiguredHook[] = [];
  for (const [eventName, entries] of Object.entries(source)) {
    if (!HOOK_EVENT_SET.has(eventName)) {
      diagnostics.push(`Unsupported plugin hook event "${eventName}" ignored.`);
      continue;
    }
    if (!Array.isArray(entries)) {
      diagnostics.push(`Plugin hook event "${eventName}" must be an array.`);
      continue;
    }
    for (const matcherEntry of entries) {
      if (!isPlainObject(matcherEntry) || !Array.isArray(matcherEntry.hooks)) {
        diagnostics.push(`Invalid hook matcher entry in "${eventName}" ignored.`);
        continue;
      }
      const matcher =
        typeof matcherEntry.matcher === 'string' && matcherEntry.matcher.trim().length > 0
          ? matcherEntry.matcher.trim().slice(0, 128)
          : undefined;
      for (const hookDef of matcherEntry.hooks) {
        if (hooks.length >= MAX_PLUGIN_HOOKS) {
          diagnostics.push(`Plugin hooks truncated at ${MAX_PLUGIN_HOOKS} entries.`);
          return hooks;
        }
        if (!isPlainObject(hookDef) || hookDef.type !== 'command' || typeof hookDef.command !== 'string') {
          diagnostics.push(`Invalid hook command definition in "${eventName}" ignored.`);
          continue;
        }
        const command = expandPluginRoot(hookDef.command.trim(), pluginRoot);
        if (!command || command.length > MAX_HOOK_COMMAND_CHARS || command.includes('\0')) {
          diagnostics.push(`Invalid or oversized hook command in "${eventName}" ignored.`);
          continue;
        }
        const timeoutSeconds =
          typeof hookDef.timeout === 'number' && Number.isFinite(hookDef.timeout) ? hookDef.timeout : undefined;
        const timeoutMs =
          timeoutSeconds === undefined
            ? DEFAULT_HOOK_TIMEOUT_MS
            : Math.min(MAX_HOOK_TIMEOUT_MS, Math.max(MIN_HOOK_TIMEOUT_MS, Math.round(timeoutSeconds * 1000)));
        hooks.push({
          scope: 'plugin',
          pluginId,
          event: eventName as HookEventName,
          ...(matcher ? {matcher} : {}),
          command,
          timeoutMs,
        });
      }
    }
  }
  return hooks;
}

function parseRawMcpServers(raw: unknown, pluginRoot: string, diagnostics: string[]): Record<string, unknown> {
  const source = isPlainObject(raw) && isPlainObject(raw.mcpServers) ? raw.mcpServers : raw;
  if (!isPlainObject(source)) {
    diagnostics.push('Plugin mcpServers definition must be an object.');
    return {};
  }
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [serverName, spec] of Object.entries(source)) {
    if (count >= MAX_PLUGIN_MCP_SERVERS) {
      diagnostics.push(`Plugin mcpServers truncated at ${MAX_PLUGIN_MCP_SERVERS} servers.`);
      break;
    }
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName) || ['__proto__', 'prototype', 'constructor'].includes(serverName)) {
      diagnostics.push(`Invalid plugin MCP server name "${serverName}" ignored.`);
      continue;
    }
    if (!isPlainObject(spec)) {
      diagnostics.push(`Invalid MCP server definition "${serverName}" ignored.`);
      continue;
    }
    out[serverName] = expandPluginRootDeep(spec, pluginRoot);
    count++;
  }
  return out;
}

function summarizeMcpGrant(serverName: string, spec: unknown): string {
  if (!isPlainObject(spec)) return `MCP server "${serverName}"`;
  if (typeof spec.url === 'string' && spec.url.trim()) {
    return `MCP HTTP server "${serverName}" -> ${spec.url.trim().slice(0, 120)}`;
  }
  if (typeof spec.command === 'string' && spec.command.trim()) {
    const args = Array.isArray(spec.args)
      ? spec.args
          .filter((a): a is string => typeof a === 'string')
          .slice(0, 4)
          .join(' ')
      : '';
    return `MCP stdio server "${serverName}" -> ${spec.command.trim()}${args ? ` ${args}` : ''}`.slice(0, 160);
  }
  return `MCP server "${serverName}"`;
}

function countSkillsInDir(dir: string): number {
  let count = 0;
  const walk = (current: string, depth: number): void => {
    if (depth > 6 || !existsSync(current)) return;
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return;
      if (existsSync(join(current, 'SKILL.md'))) {
        count++;
        return;
      }
      for (const item of readdirSync(current, {withFileTypes: true})) {
        if (item.isDirectory() && !item.name.startsWith('.')) walk(join(current, item.name), depth + 1);
      }
    } catch {
      /* ignore */
    }
  };
  walk(dir, 0);
  return count;
}

function countMarkdownFiles(dir: string, maxDepth: number): number {
  let count = 0;
  const walk = (current: string, depth: number): void => {
    if (depth > maxDepth || !existsSync(current)) return;
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return;
      for (const item of readdirSync(current, {withFileTypes: true})) {
        if (item.name.startsWith('.')) continue;
        const abs = join(current, item.name);
        if (item.isDirectory()) walk(abs, depth + 1);
        else if (item.isFile() && item.name.toLowerCase().endsWith('.md')) count++;
      }
    } catch {
      /* ignore */
    }
  };
  walk(dir, 0);
  return count;
}

function normalizePathList(
  raw: unknown,
  defaultRel: string,
  pluginRoot: string,
  diagnostics: string[],
  label: string,
): string[] {
  const candidates: string[] = [];
  if (raw === undefined) {
    const def = join(pluginRoot, defaultRel);
    if (existsSync(def) && !lstatSync(def).isSymbolicLink() && lstatSync(def).isDirectory()) {
      candidates.push(def);
    }
    return candidates;
  }
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : undefined;
  if (!list) {
    diagnostics.push(`Manifest field "${label}" must be a path string or string array.`);
    return candidates;
  }
  for (const item of list) {
    if (typeof item !== 'string') {
      diagnostics.push(`Invalid entry in manifest "${label}" ignored.`);
      continue;
    }
    const resolved = resolveInsidePlugin(pluginRoot, item.trim());
    if (!resolved) {
      diagnostics.push(`Unsafe path "${item}" in manifest "${label}" ignored.`);
      continue;
    }
    if (!existsSync(resolved)) {
      diagnostics.push(`Missing directory "${item}" in manifest "${label}".`);
      continue;
    }
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      diagnostics.push(`Path "${item}" in manifest "${label}" must be a real directory.`);
      continue;
    }
    if (!candidates.includes(resolved)) candidates.push(resolved);
  }
  return candidates;
}

/**
 * Validate and parse a plugin directory into normalized metadata, assets, hooks, MCP specs, and SHA-256 hash.
 * Throws a safe diagnostic Error if the package violates security bounds or has an invalid manifest.
 */
export function parsePluginDirectory(pluginDir: string, expectedId?: string): ParsedPluginPackage {
  const canonicalRoot = realpathSync(pluginDir);
  const scanned = scanPluginFiles(canonicalRoot);
  if (scanned.error) throw new Error(scanned.error);

  const hasher = createHash('sha256');
  for (const file of scanned.files) {
    hasher.update(file.relPath);
    hasher.update('\0');
    hasher.update(String(file.size));
    hasher.update('\0');
    hasher.update(readFileSync(file.absPath));
    hasher.update('\n');
  }
  const contentHash = hasher.digest('hex');

  let manifestPath: string | undefined;
  for (const rel of MANIFEST_CANDIDATES) {
    const abs = join(canonicalRoot, rel);
    if (existsSync(abs) && !lstatSync(abs).isSymbolicLink() && lstatSync(abs).isFile()) {
      manifestPath = abs;
      break;
    }
  }
  if (!manifestPath) {
    throw new Error(
      'Missing plugin manifest (expected plugin.json, .cosmew-plugin/plugin.json, or .claude-plugin/plugin.json).',
    );
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error('Plugin manifest is not valid JSON.');
  }
  if (!isPlainObject(rawManifest)) {
    throw new Error('Plugin manifest must be a JSON object.');
  }

  const name = typeof rawManifest.name === 'string' ? rawManifest.name.trim() : '';
  if (!PLUGIN_ID_PATTERN.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name)) {
    throw new Error('Plugin manifest "name" must match /^[a-z0-9][a-z0-9._-]{0,63}$/.');
  }
  if (expectedId && name !== expectedId) {
    throw new Error(`Plugin manifest name "${name}" does not match installed directory "${expectedId}".`);
  }
  const version =
    typeof rawManifest.version === 'string' && rawManifest.version.trim().length > 0
      ? rawManifest.version.trim().slice(0, 64)
      : '0.0.0';
  const description =
    typeof rawManifest.description === 'string'
      ? rawManifest.description
          .replace(/[\r\n\x00-\x1f\x7f]+/g, ' ')
          .trim()
          .slice(0, 500)
      : '';
  const author =
    typeof rawManifest.author === 'string'
      ? rawManifest.author
          .replace(/[\r\n\x00-\x1f\x7f]+/g, ' ')
          .trim()
          .slice(0, 120)
      : isPlainObject(rawManifest.author) && typeof rawManifest.author.name === 'string'
        ? rawManifest.author.name
            .replace(/[\r\n\x00-\x1f\x7f]+/g, ' ')
            .trim()
            .slice(0, 120)
        : undefined;

  const diagnostics: string[] = [];
  const skillDirs = normalizePathList(rawManifest.skills, 'skills', canonicalRoot, diagnostics, 'skills');
  const commandDirs = normalizePathList(rawManifest.commands, 'commands', canonicalRoot, diagnostics, 'commands');
  const agentDirs = normalizePathList(rawManifest.agents, 'agents', canonicalRoot, diagnostics, 'agents');

  let hooks: ConfiguredHook[] = [];
  if (typeof rawManifest.hooks === 'string') {
    const hooksPath = resolveInsidePlugin(canonicalRoot, rawManifest.hooks.trim());
    if (
      !hooksPath ||
      !existsSync(hooksPath) ||
      lstatSync(hooksPath).isSymbolicLink() ||
      !lstatSync(hooksPath).isFile()
    ) {
      diagnostics.push(`Plugin hooks file "${rawManifest.hooks}" is missing or unsafe.`);
    } else {
      try {
        hooks = parseHooksObject(JSON.parse(readFileSync(hooksPath, 'utf8')), name, canonicalRoot, diagnostics);
      } catch {
        diagnostics.push(`Plugin hooks file "${rawManifest.hooks}" is not valid JSON.`);
      }
    }
  } else if (rawManifest.hooks !== undefined) {
    hooks = parseHooksObject(rawManifest.hooks, name, canonicalRoot, diagnostics);
  } else {
    const defaultHooks = join(canonicalRoot, 'hooks', 'hooks.json');
    if (existsSync(defaultHooks) && !lstatSync(defaultHooks).isSymbolicLink() && lstatSync(defaultHooks).isFile()) {
      try {
        hooks = parseHooksObject(JSON.parse(readFileSync(defaultHooks, 'utf8')), name, canonicalRoot, diagnostics);
      } catch {
        diagnostics.push('Plugin hooks/hooks.json is not valid JSON.');
      }
    }
  }

  let rawMcpServers: Record<string, unknown> = {};
  if (typeof rawManifest.mcpServers === 'string') {
    const mcpPath = resolveInsidePlugin(canonicalRoot, rawManifest.mcpServers.trim());
    if (!mcpPath || !existsSync(mcpPath) || lstatSync(mcpPath).isSymbolicLink() || !lstatSync(mcpPath).isFile()) {
      diagnostics.push(`Plugin MCP file "${rawManifest.mcpServers}" is missing or unsafe.`);
    } else {
      try {
        rawMcpServers = parseRawMcpServers(JSON.parse(readFileSync(mcpPath, 'utf8')), canonicalRoot, diagnostics);
      } catch {
        diagnostics.push(`Plugin MCP file "${rawManifest.mcpServers}" is not valid JSON.`);
      }
    }
  } else if (rawManifest.mcpServers !== undefined) {
    rawMcpServers = parseRawMcpServers(rawManifest.mcpServers, canonicalRoot, diagnostics);
  } else {
    for (const candidate of ['.mcp.json', 'mcp.json']) {
      const abs = join(canonicalRoot, candidate);
      if (existsSync(abs) && !lstatSync(abs).isSymbolicLink() && lstatSync(abs).isFile()) {
        try {
          rawMcpServers = parseRawMcpServers(JSON.parse(readFileSync(abs, 'utf8')), canonicalRoot, diagnostics);
        } catch {
          diagnostics.push(`Plugin ${candidate} is not valid JSON.`);
        }
        break;
      }
    }
  }

  const grants: PluginGrantSummary[] = [
    ...hooks.map(hook => ({
      kind: 'hook' as const,
      summary: `${hook.event}${hook.matcher ? `(${hook.matcher})` : ''}: ${hook.command}`,
    })),
    ...Object.entries(rawMcpServers).map(([serverName, spec]) => ({
      kind: 'mcp' as const,
      summary: summarizeMcpGrant(serverName, spec),
    })),
  ];

  const counts: PluginAssetCounts = {
    skills: skillDirs.reduce((sum, dir) => sum + countSkillsInDir(dir), 0),
    commands: commandDirs.reduce((sum, dir) => sum + countMarkdownFiles(dir, 4), 0),
    agents: agentDirs.reduce((sum, dir) => sum + countMarkdownFiles(dir, 1), 0),
    hooks: hooks.length,
    mcpServers: Object.keys(rawMcpServers).length,
  };

  const manifest: PluginManifest = {
    name,
    version,
    description,
    ...(author ? {author} : {}),
  };

  return {
    manifest,
    contentHash,
    skillDirs,
    commandDirs,
    agentDirs,
    hooks,
    rawMcpServers,
    grants,
    counts,
    diagnostics,
  };
}

/**
 * Safely copy a validated local plugin directory into a destination directory using atomic staging.
 * Rejects symlinks, forbidden directories, and size/file-count limit violations before touching destination.
 */
export function copyPluginDirectorySafe(sourceDir: string, destinationDir: string): ParsedPluginPackage {
  const parsed = parsePluginDirectory(sourceDir);
  const canonicalSource = realpathSync(sourceDir);
  const scanned = scanPluginFiles(canonicalSource);
  if (scanned.error) throw new Error(scanned.error);

  const parent = dirname(destinationDir);
  mkdirSync(parent, {recursive: true, mode: 0o700});
  const stagingDir = `${destinationDir}.staging-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  mkdirSync(stagingDir, {recursive: true, mode: 0o700});
  try {
    for (const file of scanned.files) {
      const destFile = join(stagingDir, file.relPath);
      mkdirSync(dirname(destFile), {recursive: true, mode: 0o700});
      copyFileSync(file.absPath, destFile);
    }
    if (existsSync(destinationDir)) {
      rmSync(destinationDir, {recursive: true, force: true});
    }
    renameSync(stagingDir, destinationDir);
    return parsePluginDirectory(destinationDir, parsed.manifest.name);
  } catch (error) {
    rmSync(stagingDir, {recursive: true, force: true});
    throw error;
  }
}
