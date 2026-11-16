import { z } from 'zod';
import type { CommandOutputChunk } from './command-runtime';
import type { ToolCall } from './models';

/**
 * TOOLS1 (ADR 0017): read-only workspace tools. Descriptors carry no executable code; the
 * dispatcher in `@futryn/tools` is the single enforcement point and `@futryn/security` decides.
 */
export const toolCapabilitySchema = z.enum(['fs.read', 'fs.write', 'process.execute']);
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
  /** Historical authorization binding, never a reusable grant. */
  authorizationScopeHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
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
  /** exec_command (ADR 0022): exit code of the command; null when it was killed by a signal. */
  exitCode: z.number().int().nullable().optional(),
  /** exec_command: wall-clock run time of the process. */
  sessionId:z.string().uuid().optional(),
  durationMs: z.number().int().min(0).optional(),
});
export type ToolResult = z.infer<typeof toolResultSchema>;

/** What `core` sees: descriptors to offer and one call to run. */
export interface ToolPort {
  descriptors(): ToolDescriptor[];
  invoke(call: ToolCall, signal?: AbortSignal, onOutput?:(chunk:CommandOutputChunk)=>void): Promise<ToolResult>;
}
