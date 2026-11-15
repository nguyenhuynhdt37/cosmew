import type { PermissionDecision } from '@hannes/contracts';

/**
 * Built-in read policy for TOOLS1 (ADR 0017). Evaluation order is deny → ask → allow: the first
 * category with a match decides, so no allow can override a deny. There are no user-editable
 * rules in this slice; outside-workspace paths never reach here (the workspace layer denies them).
 */

/** File names whose contents are usually secrets: reading them needs an explicit decision. */
const SECRET_NAMES = [/^\.env$/i, /^\.env\..+/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /^id_rsa/i, /^id_ed25519/i, /^id_ecdsa/i, /^\.npmrc$/i, /^\.netrc$/i, /^\.pgpass$/i];
/** Templates that are meant to be shared. */
const SECRET_EXCEPTIONS = [/^\.env\.example$/i, /^\.env\.sample$/i, /^\.env\.template$/i];

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
