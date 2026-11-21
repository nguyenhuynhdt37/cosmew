import type {ResolvedPath} from '@cosmew/workspace';
import {sandboxConfig, type ToolDispatcherOptions} from './context';

/** Trusted `permissions.additionalDirectories` for this call. Empty when nothing has been granted. */
export function additionalDirectories(options: ToolDispatcherOptions): readonly string[] {
  return sandboxConfig(options).additionalDirectories;
}

/**
 * Resolve a model path against the project and the trusted additional directories.
 * Instructions stay on `workspace.resolve` alone; this helper is for file, search, LSP and shell tools.
 */
export function resolveWorkspacePath(options: ToolDispatcherOptions, input: string): ResolvedPath {
  return options.workspace.resolve(input, additionalDirectories(options));
}
