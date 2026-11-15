import { z } from 'zod';

export const permissionScopeSchema = z.enum(['once', 'session', 'deny']);
export type PermissionResolutionScope = z.infer<typeof permissionScopeSchema>;

export const permissionPromptRequestSchema = z.strictObject({
  approvalId: z.string().uuid(),
  capability: z.enum(['fs.read', 'fs.write', 'process.execute', 'network.connect', 'mcp.call', 'extension.service']),
  action: z.string().min(1).max(200),
  target: z.string().min(1).max(1024),
  riskLevel: z.enum(['low', 'medium', 'high']),
  reason: z.string().max(400),
  scopeHash: z.string().min(8).max(128),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  diffPreview: z.string().max(65536).optional(),
  status: z.enum(['pending', 'approved_once', 'approved_session', 'denied', 'expired']).default('pending'),
});
export type PermissionPromptRequest = z.infer<typeof permissionPromptRequestSchema>;

export const permissionPromptResolutionSchema = z.strictObject({
  approvalId: z.string().uuid(),
  scopeHash: z.string().min(8).max(128),
  decision: permissionScopeSchema,
  resolvedAt: z.string().datetime(),
});
export type PermissionPromptResolution = z.infer<typeof permissionPromptResolutionSchema>;

/**
 * Session permission mode (ADR 0027), modelled on Claude Code's modes. It only changes how an
 * `ask` decision is answered; deny rules (outside workspace, `.git`, Hannes state) never change.
 * - default: prompt for edits, commands, secret reads and anything else sensitive.
 * - acceptEdits: file edits are approved; commands and secrets still prompt.
 * - auto: edits and commands are approved; secret reads, network and other tools still prompt.
 * - bypassPermissions: every ask is approved without a prompt.
 * - plan: read-only; edits and commands are refused, secret reads still prompt.
 */
export const permissionModeSchema = z.enum(['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export const PERMISSION_MODES: readonly PermissionMode[] = permissionModeSchema.options;
/** What a permission request is about, as far as the mode is concerned. */
export type PermissionKind = 'read' | 'secret' | 'edit' | 'execute' | 'network' | 'other';
export function permissionModeDecision(mode: PermissionMode, kind: PermissionKind): 'allow' | 'ask' | 'deny' {
  if (mode === 'bypassPermissions') return 'allow';
  if (kind === 'read') return 'allow';
  if (kind === 'secret') return 'ask';
  if (mode === 'plan') return kind === 'edit' || kind === 'execute' ? 'deny' : 'ask';
  if (kind === 'edit') return mode === 'default' ? 'ask' : 'allow';
  if (kind === 'execute') return mode === 'auto' ? 'allow' : 'ask';
  return 'ask';
}

/** One-line explanation shown when Shift+Tab or /permissions changes the mode (ADR 0027). */
export const PERMISSION_MODE_HINTS: Record<PermissionMode, string> = {
  default: 'Edits, commands and secret files ask first.',
  acceptEdits: 'File edits are approved; commands and secret files ask.',
  auto: 'Edits and commands are approved; secret files, network and other tools ask.',
  plan: 'Read-only: edits and commands are refused.',
  bypassPermissions: 'Every request is approved without asking. Hard blocks (outside workspace, .git, Hannes state) still apply.',
};
