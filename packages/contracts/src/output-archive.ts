/** Redacted captured output only. Handles identify evidence; they never authorize access. */
export interface OutputArchiveScope {
  workspace: string;
  session: string;
}
export interface OutputArchiveSource {
  tool: string;
  kind: 'read' | 'search' | 'command' | 'web' | 'mcp';
  target: string;
  /** Producer already omitted bytes (for example command head/tail capture). */
  truncated: boolean;
}
export interface ArchivedToolOutput {
  outputId: string;
  source: OutputArchiveSource;
  content: string;
  permissionContext: string;
  sourceTruncated: boolean;
}
export interface ToolOutputArchive {
  put(scope: OutputArchiveScope, output: Omit<ArchivedToolOutput, 'outputId'>): string;
  get(scope: OutputArchiveScope, outputId: string): ArchivedToolOutput | undefined;
}
