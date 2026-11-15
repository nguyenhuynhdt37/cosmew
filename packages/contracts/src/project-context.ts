/** Project guidance is user-scoped request context, never a permission grant. */
export interface ProjectContextOptions {
  workingDirectory?: string;
  maxBytes?: number;
  maxFileBytes?: number;
}
export interface ProjectInstructionSource {
  path: string;
  canonicalPath: string;
  scope: string;
  hash: string;
  bytes: number;
  fileBytes: number;
  truncated: boolean;
}
export interface ProjectContextDiagnostic { code: string; path?: string }
export interface ProjectContextReport {
  root: string;
  workingDirectory: string | null;
  sources: ProjectInstructionSource[];
  diagnostics: ProjectContextDiagnostic[];
  budgetBytes: number;
  usedBytes: number;
  fingerprint: string;
  loadedAt: string;
}
export interface ProjectContextSnapshot extends ProjectContextReport {
  /** One complete bounded user-context message; empty when nothing was loaded. */
  content: string;
}
export interface ProjectContextPort {
  /** Null means the workspace has not been approved; no discovery may occur. */
  load(signal?: AbortSignal): Promise<ProjectContextSnapshot | null>;
}
export type ProjectInstructionReadResult =
  | {status: 'ok'; content: string; canonicalPath: string; fileBytes: number; truncated: boolean}
  | {status: 'missing' | 'denied' | 'error'; code: string};
export interface ProjectInstructionReader {
  read(path: string, maxBytes: number, signal?: AbortSignal): Promise<ProjectInstructionReadResult>;
}
