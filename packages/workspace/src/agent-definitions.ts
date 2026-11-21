import {existsSync, lstatSync, readdirSync, realpathSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {homedir} from 'node:os';
import type {AgentDefinitionDiagnostic, AgentDefinitionsReport, CustomAgentDefinition} from '@cosmew/contracts';
import {WorkspaceRoot} from './paths';
import {ignoredDirectory} from './files';
import {SKILL_NAME, scalar} from './skill-parser';

/** Custom agent files are bounded smaller than skills: the whole body reaches one child's context. */
export const AGENT_FILE_BYTES = 32768;
export const AGENT_DESCRIPTION_CHARS = 1024;
const MAX_AGENT_FILES = 256;

const invalid = (): never => {
  throw new Error('INVALID_AGENT_FRONTMATTER');
};

function toolList(raw: string, continuation: string[]): string[] {
  const items: string[] = [];
  const clean = (text: string) => {
    const item = text.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (item) items.push(item);
  };
  const value = raw.trim();
  if (!value) {
    for (const line of continuation) {
      if (!line.trim()) continue;
      const entry = /^\s*-\s+(.+)$/.exec(line);
      if (!entry) return invalid();
      clean(entry[1]!.replace(/\s+#.*$/, ''));
    }
  } else if (value.startsWith('[')) {
    if (!value.endsWith(']') || continuation.some(line => line.trim())) return invalid();
    for (const part of value.slice(1, -1).split(',')) clean(part);
  } else {
    if (continuation.some(line => line.trim())) return invalid();
    for (const part of value.replace(/\s+#.*$/, '').split(/[,\s]+/)) clean(part);
  }
  if (items.length > 64 || items.some(item => !/^[A-Za-z][\w.:-]{0,63}$/.test(item))) return invalid();
  return items;
}

/**
 * Minimal Claude-Code-style agent file: `---` frontmatter with `name`, `description`, `tools` (comma list, flow list
 * or block list), `model`, `reasoning_effort`; the Markdown body is the agent's guidance. Any other key
 * (`permissionMode`, `hooks`, `disallowedTools`...) has no semantics here and can never grant anything.
 */
export function parseAgentDocument(content: string): Omit<CustomAgentDefinition, 'source' | 'shortPath'> {
  if (Buffer.byteLength(content) > AGENT_FILE_BYTES || content.includes('\0')) return invalid();
  const normalized = content.replace(/^﻿/, '').replaceAll('\r\n', '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) return invalid();
  const lines = match[1]!.split('\n');
  const fields = new Map<string, unknown>();
  const keys = new Set(['name', 'description', 'tools', 'model', 'reasoning_effort', 'reasoning-effort']);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const entry = /^([a-zA-Z][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (!entry) return invalid();
    const key = entry[1]!,
      value = entry[2]?.trim() ?? '';
    const continuation: string[] = [];
    while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]!) || !lines[i + 1]!.trim())) continuation.push(lines[++i]!);
    if (!keys.has(key)) continue;
    const canonical = key === 'reasoning-effort' ? 'reasoning_effort' : key;
    if (fields.has(canonical)) return invalid();
    if (canonical === 'tools') {
      fields.set(canonical, toolList(value, continuation));
    } else if (/^[|>][-+]?$/.test(value)) {
      if (!continuation.length) return invalid();
      const indent = Math.min(...continuation.filter(s => s.trim()).map(s => s.length - s.trimStart().length));
      const text = continuation.map(s => s.slice(indent)).join(value[0] === '>' ? ' ' : '\n');
      fields.set(canonical, text.trim());
    } else {
      if (continuation.some(s => s.trim())) return invalid();
      fields.set(canonical, scalar(value));
    }
  }
  const name = fields.get('name'),
    description = fields.get('description'),
    model = fields.get('model'),
    effort = fields.get('reasoning_effort'),
    tools = fields.get('tools');
  if (
    typeof name !== 'string' ||
    !SKILL_NAME.test(name) ||
    typeof description !== 'string' ||
    !description.trim() ||
    description.length > AGENT_DESCRIPTION_CHARS ||
    (model !== undefined && (typeof model !== 'string' || model.length > 200)) ||
    (effort !== undefined && (typeof effort !== 'string' || effort.length > 40))
  )
    return invalid();
  return {
    name,
    description: description.trim(),
    tools: Array.isArray(tools) ? (tools as string[]) : null,
    ...(typeof model === 'string' && model.trim() ? {model: model.trim()} : {}),
    ...(typeof effort === 'string' && effort.trim() ? {reasoningEffort: effort.trim()} : {}),
    body: normalized.slice(match[0].length).trim(),
  };
}

interface Entry {
  definition: CustomAgentDefinition;
  path: string;
}

/**
 * Snapshot discovery of custom agents (S5b, ADR 0058): workspace up to the repository root, nearer scopes first
 * (`.cosmew`, `.futryn`, `.hannes`, `.claude`, `.agents` in each), then the user's state roots. Files are
 * regular, non-symlinked, bounded UTF-8 `*.md`; the first definition of a name wins. Discovery decides nothing about
 * permissions: every definition is untrusted data.
 */
export class AgentDefinitionCatalog {
  private readonly entries = new Map<string, Entry>();
  private readonly errors: AgentDefinitionDiagnostic[] = [];
  private readonly warnings: AgentDefinitionDiagnostic[] = [];
  constructor(options: {
    workspace: WorkspaceRoot;
    home?: string;
    /** Project/user Read policy: deny and ask rules hide a definition (same hook skills use). */
    canRead?: (relative: string, absolute: string) => boolean;
    /** Names that are reserved by built-in types; a definition using one keeps the built-in and warns. */
    reserved?: (name: string) => boolean;
  }) {
    const homePath = resolve(options.home ?? homedir());
    let home = homePath;
    try {
      home = realpathSync(homePath);
    } catch {
      /* Missing user roots do not disable project agents. */
    }
    let repo = options.workspace.root;
    for (let cursor = repo; ; cursor = dirname(cursor)) {
      if (existsSync(join(cursor, '.git'))) {
        repo = cursor;
        break;
      }
      if (dirname(cursor) === cursor) break;
    }
    const repository = new WorkspaceRoot(repo);
    const roots: {path: string; source: 'project' | 'user'}[] = [];
    for (let scope = options.workspace.root; ; scope = dirname(scope)) {
      if (!ignoredDirectory(repository, relative(repo, scope) || '.'))
        for (const dir of ['.cosmew', '.futryn', '.hannes', '.claude', '.agents'])
          roots.push({path: join(scope, dir, 'agents'), source: 'project'});
      if (scope === repo) break;
    }
    for (const dir of ['.cosmew', '.futryn', '.claude', '.hannes'])
      roots.push({path: join(home, dir, 'agents'), source: 'user'});
    let files = 0;
    for (const scan of roots) {
      try {
        if (!existsSync(scan.path)) continue;
        if (scan.source === 'project' && ignoredDirectory(repository, relative(repo, scan.path))) continue;
        if (!lstatSync(scan.path).isDirectory() || realpathSync(scan.path) !== scan.path) {
          this.errors.push({path: this.short(scan, scan.path, repo, home), code: 'UNSAFE_AGENT_PATH'});
          continue;
        }
        for (const item of readdirSync(scan.path, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
          if (!item.name.toLowerCase().endsWith('.md') || item.name.startsWith('.')) continue;
          const path = join(scan.path, item.name);
          const shortPath = this.short(scan, path, repo, home);
          if (++files > MAX_AGENT_FILES) {
            this.warnings.push({path: shortPath, code: 'DISCOVERY_LIMIT'});
            break;
          }
          try {
            if (!lstatSync(path).isFile() || realpathSync(path) !== path) {
              this.errors.push({path: shortPath, code: 'UNSAFE_AGENT_PATH'});
              continue;
            }
            const rel = scan.source === 'project' ? relative(options.workspace.root, path) : shortPath;
            if (options.canRead && !options.canRead(rel, path)) {
              this.errors.push({path: shortPath, code: 'DENIED'});
              continue;
            }
            const parsed = this.readDefinition(path);
            const definition: CustomAgentDefinition = {...parsed, source: scan.source, shortPath};
            if (options.reserved?.(parsed.name)) {
              this.warnings.push({path: shortPath, code: 'BUILTIN_NAME_CLASH'});
              continue;
            }
            const key = parsed.name.toLowerCase();
            if (this.entries.has(key)) this.warnings.push({path: shortPath, code: 'DUPLICATE_NAME'});
            else this.entries.set(key, {definition, path});
          } catch {
            this.errors.push({path: shortPath, code: 'INVALID_OR_UNREADABLE_AGENT'});
          }
        }
      } catch {
        this.errors.push({path: this.short(scan, scan.path, repo, home), code: 'INVALID_OR_UNREADABLE_AGENT'});
      }
    }
  }
  private short(scan: {source: 'project' | 'user'}, path: string, repo: string, home: string): string {
    return scan.source === 'project' ? relative(repo, path) : `~/${relative(home, path)}`;
  }
  private readDefinition(path: string): Omit<CustomAgentDefinition, 'source' | 'shortPath'> {
    const root = new WorkspaceRoot(dirname(path));
    const file = root.resolve(path.slice(dirname(path).length + 1));
    const {bytes, size} = root.readBytes(file, AGENT_FILE_BYTES + 1);
    if (size > AGENT_FILE_BYTES) throw new Error('AGENT_TOO_LARGE');
    return parseAgentDocument(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  }
  /** Definitions without bodies, in precedence order. */
  report(): AgentDefinitionsReport {
    return structuredClone({
      definitions: [...this.entries.values()].map(({definition: {body: _body, ...rest}}) => rest),
      errors: this.errors,
      warnings: this.warnings,
    });
  }
  /** Re-read and re-validate one definition at spawn time (swap/edit since discovery is detected). */
  load(name: string): CustomAgentDefinition | undefined {
    const entry = this.entries.get(name.trim().toLowerCase());
    if (!entry) return undefined;
    if (realpathSync(entry.path) !== entry.path || !lstatSync(entry.path).isFile()) return undefined;
    const parsed = this.readDefinition(entry.path);
    if (parsed.name.toLowerCase() !== name.trim().toLowerCase()) return undefined;
    return {...parsed, source: entry.definition.source, shortPath: entry.definition.shortPath};
  }
}
