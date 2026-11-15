import { z } from 'zod';
import type { ToolCall } from './models';

/**
 * TOOLS1 (ADR 0017): read-only workspace tools. Descriptors carry no executable code; the
 * dispatcher in `@hannes/tools` is the single enforcement point and `@hannes/security` decides.
 */
export const toolCapabilitySchema = z.enum(['fs.read']);
export type ToolCapability = z.infer<typeof toolCapabilitySchema>;

export interface ToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema for the arguments, offered to the model. */
  inputSchema: Record<string, unknown>;
  capability: ToolCapability;
}

/** Outcome of evaluating one target against policy. Deny wins over ask, ask over allow. */
export interface PermissionDecision {
  effect: 'allow' | 'ask' | 'deny';
  /** Stable machine-readable reason, e.g. `outside-workspace`, `secret-file`, `default-allow`. */
  reason: string;
}

export const toolResultSchema = z.strictObject({
  callId: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  status: z.enum(['ok', 'denied', 'error']),
  /** Bounded, redacted text returned to the model. */
  content: z.string().max(65536),
  /** Workspace-relative target shown to the user (never an absolute path outside it). */
  target: z.string().max(1024).optional(),
  truncated: z.boolean().optional(),
  /** Safe error code for `denied` / `error`. */
  code: z.string().max(64).optional(),
});
export type ToolResult = z.infer<typeof toolResultSchema>;

/** What `core` sees: descriptors to offer and one call to run. */
export interface ToolPort {
  descriptors(): ToolDescriptor[];
  invoke(call: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
}
