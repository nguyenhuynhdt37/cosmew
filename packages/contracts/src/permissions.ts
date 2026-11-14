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
