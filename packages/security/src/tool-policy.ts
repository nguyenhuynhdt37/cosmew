import type { PermissionDecision } from '@hannes/contracts';

/**
 * Built-in read policy for TOOLS1 (ADR 0017). Evaluation order is deny → ask → allow: the first
 * category with a match decides, so no allow can override a deny. There are no user-editable
 * rules in this slice; outside-workspace paths never reach here (the workspace layer denies them).
 */

/**
 * File names whose contents are usually secrets. One table feeds both the read tool (ask) and the
 * command sandbox (always masked, ADR 0022), so the two cannot drift apart. Matching ignores case.
 */
export const SECRET_FILE_RULES: readonly { match: 'exact' | 'prefix' | 'suffix'; value: string }[] = [
  { match: 'exact', value: '.env' }, { match: 'prefix', value: '.env.' },
  { match: 'suffix', value: '.pem' }, { match: 'suffix', value: '.key' }, { match: 'suffix', value: '.p12' }, { match: 'suffix', value: '.pfx' },
  { match: 'prefix', value: 'id_rsa' }, { match: 'prefix', value: 'id_ed25519' }, { match: 'prefix', value: 'id_ecdsa' },
  { match: 'exact', value: '.npmrc' }, { match: 'exact', value: '.netrc' }, { match: 'exact', value: '.pgpass' },
];
/** Templates that are meant to be shared. */
export const SECRET_FILE_EXCEPTIONS: readonly string[] = ['.env.example', '.env.sample', '.env.template'];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SECRET_NAMES = SECRET_FILE_RULES.map(rule => new RegExp(rule.match === 'exact' ? `^${escape(rule.value)}$` : rule.match === 'prefix' ? `^${escape(rule.value)}${rule.value.endsWith('.') ? '.+' : ''}` : `${escape(rule.value)}$`, 'i'));
const SECRET_EXCEPTIONS = SECRET_FILE_EXCEPTIONS.map(name => new RegExp(`^${escape(name)}$`, 'i'));

export interface ReadPolicyContext {
  /** Absolute path of Hannes's own state directory (credentials metadata, sessions). */
  stateDirectory?: string;
}

/** Decide one workspace-relative path (`/` separators) whose canonical absolute path is known. */
export function evaluateRead(relativePath: string, absolutePath: string, context: ReadPolicyContext = {}): PermissionDecision {
  // Case-insensitive file systems (macOS/Windows default) open `.ENV` or `.Git/config` as the real
  // file, so every comparison ignores case; callers also pass on-disk casing via realpath.native.
  const segments = relativePath.toLowerCase().split('/');
  const name = segments.at(-1) ?? '';
  const absolute = absolutePath.replace(/\\/g, '/').toLowerCase();
  const state = context.stateDirectory?.replace(/\\/g, '/').toLowerCase();
  // deny
  if (state && (absolute === state || absolute.startsWith(state + '/'))) {
    return { effect: 'deny', reason: 'hannes-state' };
  }
  if (segments.includes('.git')) return { effect: 'deny', reason: 'git-internals' };
  // ask
  if (SECRET_NAMES.some(pattern => pattern.test(name)) && !SECRET_EXCEPTIONS.some(pattern => pattern.test(name))) {
    return { effect: 'ask', reason: 'secret-file' };
  }
  // allow
  return { effect: 'allow', reason: 'default-allow' };
}

/**
 * Session-scoped grants a user gave with "Allow for session". Keys bind the capability and the
 * canonical target; nothing is persisted, and a revoke takes effect on the next check.
 */
export class SessionGrants {
  private readonly grants = new Set<string>();

  private key(capability: string, target: string): string { return `${capability}\0${target}`; }

  has(capability: string, target: string): boolean { return this.grants.has(this.key(capability, target)); }

  grant(capability: string, target: string): void { this.grants.add(this.key(capability, target)); }

  revoke(capability: string, target: string): void { this.grants.delete(this.key(capability, target)); }

  list(): { capability: string; target: string }[] {
    return [...this.grants].map(entry => { const [capability, target] = entry.split('\0'); return { capability: capability!, target: target! }; });
  }

  clear(): void { this.grants.clear(); }
}

/** Longest command string accepted by the execution policy (ADR 0022). */
export const MAX_COMMAND_CHARS = 1024;

/**
 * Policy for one sandboxed command (ADR 0022). There is no allow branch: a command either is
 * denied or needs an explicit user decision bound to the command, the canonical working directory
 * and the sandbox policy. File-read grants never authorize execution.
 */
export function evaluateExec(command: string, workdirRelative: string, workdirAbsolute: string, context: ReadPolicyContext = {}): PermissionDecision {
  if (!command.trim() || command.length > MAX_COMMAND_CHARS || /[\u0000]/.test(command)) return { effect: 'deny', reason: 'invalid-command' };
  const location = evaluateRead(workdirRelative === '.' ? '.' : workdirRelative + '/', workdirAbsolute, context);
  if (location.effect === 'deny') return location;
  return { effect: 'ask', reason: 'process-execute' };
}

/** Patch writes cannot modify credentials, Git internals or Hannes durable state. */
export function evaluateWrite(relativePath:string,absolutePath:string,context:ReadPolicyContext={}):PermissionDecision {
 const read=evaluateRead(relativePath,absolutePath,context);
 if(read.effect!=='allow')return {effect:'deny',reason:read.reason};
 if(relativePath.toLowerCase().split('/').some(p=>p==='.hannes'||p.startsWith('.hannes-patch-')))return {effect:'deny',reason:'protected-path'};
 return {effect:'ask',reason:'workspace-patch'};
}
