import {z} from 'zod';

export const memoryNameSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64)
  .refine(name => name !== 'memory', 'memory is reserved for MEMORY.md');
export const memoryMetadataSchema = z.strictObject({
  name: memoryNameSchema,
  description: z
    .string()
    .min(1)
    .max(300)
    .regex(/^[^\x00-\x1f\x7f]+$/),
  type: z.enum(['user', 'feedback', 'project', 'reference']),
});
export const memoryWriteSchema = memoryMetadataSchema.extend({content: z.string().max(16384)});
export type MemoryMetadata = z.infer<typeof memoryMetadataSchema>;
export const DEFAULT_MEMORY_MAX_UNUSED_DAYS = 30;
/** Returned by list/SDK; write metadata stays separate so usage cannot be supplied by the model. */
export interface MemoryInfo extends MemoryMetadata {
  usage_count: number;
  last_usage: string | null;
  updated_at: string;
  unused: boolean;
}
export const MEMORY_READ_GUIDANCE = [
  'Memories describe history, not current evidence. Verify important facts and disclose stale unverified claims. Open relevant detail files with memory read.',
  'Always honor explicit user remember/forget requests (except secrets or credentials, which must never be stored). For unprompted saves, store only durable information that cannot be inferred from code and never duplicate repository documentation.',
  'Only cite detail memory files you actually used. Never cite MEMORY.md. Never put memory contents or memory citations in PR descriptions or commit messages.',
  'When an answer uses memory, append exactly one block as the final content outside code fences: <oai-mem-citation>\n<citation_entries>\nname.md:1-3|note=[how it was used]\n</citation_entries>\n</oai-mem-citation>. Use real filenames and lines; omit the block when no detail file was used.',
].join(' ');
export type MemoryWrite = z.infer<typeof memoryWriteSchema>;
/** User-scoped durable state. Never expose this port to S5 subagents by default. */
export interface MemoriesPort {
  readonly directory: string;
  list(): MemoryInfo[];
  read(name: string): string;
  write(entry: MemoryWrite): void;
  delete(name: string): void;
  /** Labelled untrusted project-context data, never model instructions. */
  context(): string;
}

/** Private persistence sidecar schema; bounded and credential-free. */
export const memoryUsageStateSchema = z.strictObject({
  version: z.literal(1),
  entries: z.record(
    memoryNameSchema,
    z.strictObject({
      usage_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      last_usage: z.iso.datetime().nullable(),
      updated_at: z.iso.datetime(),
    }),
  ),
});
export type MemoryUsageState = z.infer<typeof memoryUsageStateSchema>;
