import {realpathSync, statSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {locateWriteTarget, WorkspaceDenied, type ResolvedPath, type WriteTarget} from '@cosmew/workspace';
import {readDecision, sandboxConfig, type ToolDispatcherOptions} from './context';

export const OUTSIDE_WORKING_DIRECTORIES_MESSAGE =
  'Access outside the working directories needs permission. Deny rules and protected paths still apply.';

/** Trusted `permissions.additionalDirectories` for this call. Empty when nothing has been granted. */
export function additionalDirectories(options: ToolDispatcherOptions): readonly string[] {
  return sandboxConfig(options).additionalDirectories;
}

/**
 * Normalize file-tool paths, including external targets that still require permission.
 * Instructions stay on `workspace.resolve` alone; this helper is for file, search, LSP and shell tools.
 */
const expand = (input: string) =>
  input === '~' ? homedir() : input.startsWith('~/') ? join(homedir(), input.slice(2)) : input;

/** Normalization root only, not a permission grant or an OS-sandbox writable root. */
function externalTarget(options: ToolDispatcherOptions, input: string): {absolute: string; root: string} {
  let current = resolve(options.workspace.root, input);
  const missing: string[] = [];
  for (;;) {
    try {
      const canonical = realpathSync.native(current);
      return {
        absolute: join(canonical, ...missing),
        root: statSync(canonical).isDirectory() ? canonical : dirname(canonical),
      };
    } catch (error) {
      const code = (error as {code?: string}).code;
      if (!['ENOENT', 'ENOTDIR'].includes(code ?? '')) throw new WorkspaceDenied('inaccessible');
      const parent = dirname(current);
      if (parent === current) throw new WorkspaceDenied('not-found');
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

export function resolveWorkspacePath(options: ToolDispatcherOptions, input: string): ResolvedPath {
  input = expand(input);
  try {
    return options.workspace.resolve(input, additionalDirectories(options));
  } catch (error) {
    if (!(error instanceof WorkspaceDenied) || error.reason !== 'outside-workspace') throw error;
    const target = externalTarget(options, input);
    return options.workspace.resolve(target.absolute, [...additionalDirectories(options), target.root]);
  }
}

export function locateWorkspaceWriteTarget(options: ToolDispatcherOptions, input: string): WriteTarget {
  input = expand(input);
  try {
    return locateWriteTarget(options.workspace, input, additionalDirectories(options));
  } catch (error) {
    if (!(error instanceof WorkspaceDenied) || error.reason !== 'outside-workspace') throw error;
    const target = externalTarget(options, input);
    return locateWriteTarget(options.workspace, target.absolute, [...additionalDirectories(options), target.root]);
  }
}

export function outsideWorkingDirectories(options: ToolDispatcherOptions, absolute: string): boolean {
  try {
    options.workspace.resolve(absolute, additionalDirectories(options));
    return false;
  } catch (error) {
    if (error instanceof WorkspaceDenied && error.reason === 'not-found') {
      try {
        locateWriteTarget(options.workspace, absolute, additionalDirectories(options));
        return false;
      } catch {}
    }
    return true;
  }
}

/** Per-call authority. Dedicated skill reads already pin an exact catalog-discovered file; ordinary Read does not gain that exception. */
export function readTargetDecision(options: ToolDispatcherOptions, file: ResolvedPath, skillRead = false) {
  const decision = readDecision(options, file.relative, file.absolute, skillRead);
  if (
    decision.effect === 'allow' &&
    !skillRead &&
    outsideWorkingDirectories(options, file.absolute) &&
    options.readPolicy?.(file.relative, file.absolute) !== 'allow'
  )
    return {effect: 'ask' as const, reason: 'outside-working-directories'};
  return decision;
}
