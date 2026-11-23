export const SKILL_VISIBILITIES = ['on', 'name-only', 'user-invocable-only', 'off'] as const;
export type SkillVisibility = (typeof SKILL_VISIBILITIES)[number];

/** S3 / ADR 0056: content-free catalog; metadata never grants permissions. */
export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
  directory: string;
  shortPath: string;
  source: 'project' | 'user' | 'system';
  disableModelInvocation: boolean;
  visibility?: SkillVisibility;
  argumentHint?: string;
}
export interface SkillDiagnostic {
  path?: string;
  code: string;
}
export interface SkillsReport {
  skills: SkillMetadata[];
  errors: SkillDiagnostic[];
  warnings: SkillDiagnostic[];
}
/** Core only sees this injected port. Body text is user-scoped, turn-local data. */
export interface SkillsPort {
  /** Legacy method name: catalog metadata for untrusted user/project context, never ModelRequest.instructions. */
  instructions(): string;
  loadPrompt(prompt: string, signal?: AbortSignal): Promise<string[]>;
}
